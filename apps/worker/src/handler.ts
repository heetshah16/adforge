import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { guard, withCors } from './cors';
import { send, toRequest } from './http';
import type { makeRoutes } from './routes';

type Env = { ADFORGE_WORKER_PORT: number; ADFORGE_UI_ORIGIN: string };

/** All request dispatch. The Host/Origin guard runs first, for every path including /api/inngest. */
export function makeHandler(ctx: { routes: ReturnType<typeof makeRoutes>; inngestHandler(req: IncomingMessage, res: ServerResponse): unknown; env: Env }): RequestListener {
  const { routes, inngestHandler, env } = ctx;
  const base = `http://127.0.0.1:${env.ADFORGE_WORKER_PORT}`;
  const cors = (h: Record<string, string>) => ({ ...h, 'access-control-allow-origin': env.ADFORGE_UI_ORIGIN, vary: 'origin' });
  return async (req, res) => {
    try {
      const refused = guard(req.method, req.headers, env.ADFORGE_WORKER_PORT, env.ADFORGE_UI_ORIGIN);
      if (refused) {
        await send(res, withCors(refused, env.ADFORGE_UI_ORIGIN));
        return;
      }
      const url = new URL(req.url ?? '/', base);
      if (url.pathname.startsWith('/api/inngest')) {
        // inngest/node's serve() listener is async at runtime (node.js), so await observes its rejections even though the type says void.
        await inngestHandler(req, res);
        return;
      }
      // Uploads must declare their size so the 30 MB cap is enforced before the body is buffered.
      if (req.method === 'POST' && url.pathname === '/api/jobs' && !req.headers['content-length']) {
        res.writeHead(411, cors({ 'content-type': 'application/json' })).end(JSON.stringify({ error: 'content-length required' }));
        return;
      }
      const r = toRequest(req, base);
      const handler =
        req.method === 'POST' && url.pathname === '/api/jobs' ? routes.createJob
        : req.method === 'GET' && /^\/api\/jobs\/[^/]+$/.test(url.pathname) ? routes.getJob
        : req.method === 'GET' && url.pathname.startsWith('/media/') ? routes.getMedia
        : req.method === 'GET' && url.pathname === '/health' ? routes.health
        : null;
      await send(res, withCors(handler ? await handler(r) : new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'content-type': 'application/json' } }), env.ADFORGE_UI_ORIGIN));
    } catch (e) {
      console.error(e);
      if (res.headersSent) res.end();
      else res.writeHead(500, cors({ 'content-type': 'application/json' })).end(JSON.stringify({ error: 'internal error' }));
    }
  };
}
