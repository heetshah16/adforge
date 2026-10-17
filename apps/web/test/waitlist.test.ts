import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDb } from '@adforge/db/client';
import { waitlist } from '@adforge/db/schema';
import { waitlistHandler, type WaitlistCtx } from '../lib/server/waitlist-api';
import { insertWaitlist } from '../lib/server/waitlist-owner';
import { rateLimit } from '../lib/server/rate-limit';

const valid = (over: Record<string, unknown> = {}) => ({
  name: 'Asha', email: `asha-${randomUUID()}@Example.com`, brand: 'Glow', category: 'Skincare', country: 'India',
  startedAt: Date.now() - 10_000, ...over,
});
const post = (body: unknown, ip = `10.0.${Math.floor(Math.random() * 250)}.1`) =>
  new Request('http://w/api/waitlist', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `${ip}, 9.9.9.9` }, body: typeof body === 'string' ? body : JSON.stringify(body),
  });

describe('waitlist route (pglite)', () => {
  let h: Awaited<ReturnType<typeof openDb>>;
  let ctx: WaitlistCtx;
  const rows = (email: string) => h.db.select().from(waitlist).where(eq(waitlist.email, email));
  const count = async () => (await h.db.select({ id: waitlist.id }).from(waitlist)).length;

  beforeAll(async () => {
    h = await openDb();
    ctx = { insert: (row) => insertWaitlist(h.db, row), rateLimit };
  });
  afterAll(async () => { await h.close(); });

  it('valid submission inserts a lower-cased email and returns ok', async () => {
    const body = valid({ email: 'Mixed.Case@Example.com' });
    const res = await waitlistHandler(ctx, post(body));
    expect([res.status, await res.json()]).toEqual([200, { ok: true }]);
    const [row] = await rows('mixed.case@example.com');
    expect(row).toMatchObject({ name: 'Asha', brand: 'Glow', category: 'Skincare', country: 'India', status: 'new' });
  });

  it('duplicate email (any case) is ok and does not overwrite the first row', async () => {
    const first = valid({ email: 'dup@example.com', name: 'First' });
    await waitlistHandler(ctx, post(first));
    const res = await waitlistHandler(ctx, post(valid({ email: 'DUP@example.com', name: 'Second' })));
    expect([res.status, await res.json()]).toEqual([200, { ok: true }]);
    const found = await rows('dup@example.com');
    expect(found.map((r) => r.name)).toEqual(['First']);
  });

  it('honeypot filled -> 200 and nothing inserted', async () => {
    const before = await count();
    const res = await waitlistHandler(ctx, post(valid({ company_url: 'https://spam.example' })));
    expect([res.status, await res.json()]).toEqual([200, { ok: true }]);
    expect(await count()).toBe(before);
  });

  it('submitted under 3 seconds after render -> 200 and nothing inserted', async () => {
    const before = await count();
    const res = await waitlistHandler(ctx, post(valid({ startedAt: Date.now() - 1000 })));
    expect([res.status, await res.json()]).toEqual([200, { ok: true }]);
    expect(await count()).toBe(before);
  });

  it('body over 8 KB -> 413 and nothing inserted', async () => {
    const before = await count();
    const res = await waitlistHandler(ctx, post(valid({ note: 'x'.repeat(9 * 1024) })));
    expect(res.status).toBe(413);
    expect(await count()).toBe(before);
  });

  it('body over 8 KB with no Content-Length (chunked) -> 413', async () => {
    const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('x'.repeat(9 * 1024))); c.close(); } });
    const req = new Request('http://w/api/waitlist', { method: 'POST', body: stream, duplex: 'half', headers: { 'x-forwarded-for': '10.1.1.1' } } as RequestInit);
    expect((await waitlistHandler(ctx, req)).status).toBe(413);
  });

  it('invalid fields -> 400 with issues, nothing inserted', async () => {
    const before = await count();
    const res = await waitlistHandler(ctx, post(valid({ email: 'not-an-email', website: 'javascript:alert(1)' })));
    const json = (await res.json()) as { error: string; issues: Record<string, string[]> };
    expect(res.status).toBe(400);
    expect(Object.keys(json.issues).sort()).toEqual(['email', 'website']);
    expect(await count()).toBe(before);
  });

  it('missing a required field or malformed JSON -> 400', async () => {
    expect((await waitlistHandler(ctx, post(valid({ brand: '' })))).status).toBe(400);
    expect((await waitlistHandler(ctx, post('{not json'))).status).toBe(400);
  });

  it('6th submission from one IP in 10 minutes -> 429; other IPs unaffected', async () => {
    const ip = '203.0.113.7';
    for (let i = 0; i < 5; i++) expect((await waitlistHandler(ctx, post(valid(), ip))).status).toBe(200);
    expect((await waitlistHandler(ctx, post(valid(), ip))).status).toBe(429);
    expect((await waitlistHandler(ctx, post(valid(), '203.0.113.8'))).status).toBe(200);
  });
});
