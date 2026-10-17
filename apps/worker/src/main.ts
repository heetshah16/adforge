import { createServer } from 'node:http';
import { join } from 'node:path';
import { serve } from 'inngest/node';
import { REPO_ROOT, dataDirWarnings, parseEnv } from '@adforge/core/config/env';
import { createFunctions, inngest } from '@adforge/pipeline';
import { buildDeps } from './deps';
import { makeHandler } from './handler';
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
const routes = makeRoutes({ deps, storage, sendEvent: async (name, data, id) => { await inngest.send({ name, data: data as Record<string, unknown>, ...(id ? { id } : {}) }); } });
const base = `http://127.0.0.1:${env.ADFORGE_WORKER_PORT}`;

const server = createServer(makeHandler({ routes, inngestHandler, env }));

server.requestTimeout = 120_000; // bounds request *receipt* (slow uploads), not handler run time
server.listen(env.ADFORGE_WORKER_PORT, '127.0.0.1', () => console.log(`worker on ${base}`));

const shutdown = makeShutdown({ server, close, exit: (c) => process.exit(c) });
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
// Windows: console window closed / Ctrl-Break.
process.on('SIGHUP', () => void shutdown('SIGHUP'));
process.on('SIGBREAK', () => void shutdown('SIGBREAK'));
