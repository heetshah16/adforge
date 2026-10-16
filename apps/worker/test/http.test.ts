import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { send, toRequest } from '../src/http';

describe('node:http ⇄ Web adapter', () => {
  it('round-trips method, headers, body and status', async () => {
    const server = createServer(async (req, res) => {
      const r = toRequest(req, 'http://127.0.0.1');
      const body = await r.text();
      await send(res, new Response(JSON.stringify({ m: r.method, h: r.headers.get('x-a'), body }), { status: 201, headers: { 'content-type': 'application/json' } }));
    });
    await new Promise<void>((ok) => server.listen(0, ok));
    const port = (server.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/x`, { method: 'POST', headers: { 'x-a': '1' }, body: 'hello' });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ m: 'POST', h: '1', body: 'hello' });
    server.close();
  });
});
