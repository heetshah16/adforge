import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeHandler } from '../src/handler';
import type { makeRoutes } from '../src/routes';

const UI = 'http://localhost:3000';
let server: Server | undefined;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

async function start(over: Partial<ReturnType<typeof makeRoutes>> = {}) {
  const inngestHandler = vi.fn((_req: IncomingMessage, res: ServerResponse) => { res.writeHead(200).end('inngest'); });
  const ok = async () => new Response('{}', { headers: { 'content-type': 'application/json' } });
  const routes = { health: ok, createJob: ok, getJob: ok, getMedia: ok, ...over } as ReturnType<typeof makeRoutes>;
  // The port is only known after listen(); the handler reads env.ADFORGE_WORKER_PORT per request, so build it lazily.
  const env = { ADFORGE_WORKER_PORT: 0, ADFORGE_UI_ORIGIN: UI };
  let handler: ReturnType<typeof makeHandler> | undefined;
  server = createServer((q, s) => handler!(q, s));
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  env.ADFORGE_WORKER_PORT = port;
  handler = makeHandler({ routes, inngestHandler, env });
  const call = (method: string, path: string, headers: Record<string, string> = {}, chunked = false) =>
    new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((resolve, reject) => {
      const q = request({ host: '127.0.0.1', port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers } }, (s) => {
        let body = '';
        s.on('data', (d) => (body += d));
        s.on('end', () => resolve({ status: s.statusCode!, headers: s.headers, body }));
      });
      q.on('error', reject);
      if (chunked) q.write('x');
      q.end();
    });
  return { call, inngestHandler, port };
}

describe('makeHandler guard covers every route', () => {
  it('foreign-Origin POST to /api/inngest -> 403 and the inngest handler is not called', async () => {
    const t = await start();
    const r = await t.call('POST', '/api/inngest', { origin: 'https://evil.example', 'content-type': 'text/plain' });
    expect(r.status).toBe(403);
    expect(t.inngestHandler).not.toHaveBeenCalled();
  });
  it('bad Host on /api/inngest -> 403', async () => {
    const t = await start();
    expect((await t.call('GET', '/api/inngest', { host: 'evil.example' })).status).toBe(403);
    expect(t.inngestHandler).not.toHaveBeenCalled();
  });
  it('no-Origin POST from 127.0.0.1 to /api/inngest reaches the handler', async () => {
    const t = await start();
    const r = await t.call('POST', '/api/inngest');
    expect(r).toMatchObject({ status: 200, body: 'inngest' });
    expect(t.inngestHandler).toHaveBeenCalledOnce();
  });
  it.each(['/api/jobs/00000000-0000-0000-0000-000000000000', '/media/a.png', '/health'])('bad Host on GET %s -> 403 with CORS', async (path) => {
    const t = await start();
    const r = await t.call('GET', path, { host: 'rebind.example:3001' });
    expect(r.status).toBe(403);
    expect(r.headers['access-control-allow-origin']).toBe(UI);
  });
  it('foreign-Origin POST to approve -> 403', async () => {
    const t = await start();
    expect((await t.call('POST', '/api/jobs/x/variants/1/approve', { origin: 'https://evil.example' })).status).toBe(403);
  });
  it('411 carries CORS headers', async () => {
    const t = await start();
    const r = await t.call('POST', '/api/jobs', { 'transfer-encoding': 'chunked' }, true);
    expect(r.status).toBe(411);
    expect(r.headers['access-control-allow-origin']).toBe(UI);
    expect(r.headers.vary).toBe('origin');
  });
  it('500 carries CORS headers', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const t = await start({ getJob: async () => { throw new Error('boom'); } });
    const r = await t.call('GET', '/api/jobs/00000000-0000-0000-0000-000000000000');
    expect(r.status).toBe(500);
    expect(r.headers['access-control-allow-origin']).toBe(UI);
    expect(r.headers.vary).toBe('origin');
  });
});
