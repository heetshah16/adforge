import { describe, expect, it } from 'vitest';
import { guard, withCors } from '../src/cors';

describe('withCors', () => {
  it('allows the UI origin and keeps status, body and headers', async () => {
    const r = withCors(new Response('{"a":1}', { status: 201, headers: { 'content-type': 'application/json' } }), 'http://localhost:3000');
    expect(r.status).toBe(201);
    expect(r.headers.get('access-control-allow-origin')).toBe('http://localhost:3000');
    expect(r.headers.get('vary')).toBe('origin');
    expect(r.headers.get('content-type')).toBe('application/json');
    expect(await r.text()).toBe('{"a":1}');
  });
});

describe('guard (CSRF Origin + DNS-rebinding Host)', () => {
  const UI = 'http://localhost:3000';
  const g = (method: string, h: Record<string, string>) => guard(method, h, 3001, UI);
  const host = { host: '127.0.0.1:3001' };

  it('POST with a foreign Origin -> 403', async () => {
    const r = g('POST', { ...host, origin: 'https://evil.example' });
    expect(r?.status).toBe(403);
    expect(await r?.json()).toEqual({ error: 'origin not allowed' });
  });
  it.each(['PUT', 'PATCH', 'DELETE'])('%s with a foreign Origin is 403', (m) => expect(g(m, { ...host, origin: 'https://evil.example' })?.status).toBe(403));
  it('POST with the UI origin passes', () => expect(g('POST', { ...host, origin: UI })).toBeNull());
  it('POST with no Origin passes (curl, e2e)', () => expect(g('POST', host)).toBeNull());
  it('GET with a foreign Origin is not blocked (CORS limits reads)', () => expect(g('GET', { ...host, origin: 'https://evil.example' })).toBeNull());
  it.each(['evil.example', 'evil.example:3001', '127.0.0.1:9999', '127.0.0.1', ''])('bad Host %j -> 403', (h) => {
    expect(g('GET', { host: h })?.status).toBe(403);
  });
  it('missing Host -> 403', () => expect(g('GET', {})?.status).toBe(403));
  it('localhost:<port> Host passes', () => expect(g('GET', { host: 'localhost:3001' })).toBeNull());
});
