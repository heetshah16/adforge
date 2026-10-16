import { createServer } from 'node:http';
import { join } from 'node:path';
import { serve } from 'inngest/node';
import { REPO_ROOT, dataDirWarnings, parseEnv } from '@adforge/core/config/env';
import { createFunctions, inngest } from '@adforge/pipeline';
import { buildDeps } from './deps';
import { send, toRequest } from './http';
import { makeRoutes } from './routes';
import { makeShutdown } from './shutdown';

try {
  process.loadEnvFile(join(REPO_ROOT, '.env'));
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
}
const env = parseEnv(process.env);
for (const w of dataDirWarnings(env.ADFORGE_DATA_DIR)) console.warn(`WARN ${w}`);

const { deps, storage, close } = await buildDeps(env);
const inngestHandler = serve({ client: inngest, functions: createFunctions(deps) });
const routes = makeRoutes({ deps, storage, sendEvent: async (name, data) => { await inngest.send({ name, data: data as Record<string, unknown> }); } });
const base = `http://127.0.0.1:${env.ADFORGE_WORKER_PORT}`;

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', base);
    if (url.pathname.startsWith('/api/inngest')) {
      await inngestHandler(req, res);
      return;
    }
    // Uploads must declare their size so the 30 MB cap is enforced before the body is buffered.
    if (req.method === 'POST' && url.pathname === '/api/jobs' && !req.headers['content-length']) {
      res.writeHead(411, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'content-length required' }));
      return;
    }
    const r = toRequest(req, base);
    const handler =
      req.method === 'POST' && url.pathname === '/api/jobs' ? routes.createJob
      : req.method === 'GET' && /^\/api\/jobs\/[^/]+$/.test(url.pathname) ? routes.getJob
      : req.method === 'GET' && url.pathname.startsWith('/media/') ? routes.getMedia
      : req.method === 'GET' && url.pathname === '/health' ? routes.health
      : null;
    await send(res, handler ? await handler(r) : new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'content-type': 'application/json' } }));
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.writeHead(500).end('internal error');
  }
});
server.requestTimeout = 120_000; // liveness: no request may hang the worker
server.listen(env.ADFORGE_WORKER_PORT, '127.0.0.1', () => console.log(`worker on ${base}`));

const shutdown = makeShutdown({ server, close, exit: (c) => process.exit(c) });
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
