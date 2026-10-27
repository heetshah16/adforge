import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDb } from '@adforge/db/client';
import { seedVocabulary } from '@adforge/db/seed/seed';
import { assets, jobs, projects, variantRevisions, variants } from '@adforge/db/schema';
import { withUser } from '@adforge/db/with-user';
import { LocalDiskStorage } from '@adforge/provider-local-storage';
import { NUDGE_TIMEOUT_MS, approveHandler, createJobHandler, getJobHandler, type JobsCtx } from '../lib/server/jobs-api';
import { requireApiUserWith } from '../lib/server/session';
import { ProvisionRefused } from '../lib/server/provision-owner';
import { dropTenants, makeTenant, type Tenant } from './tenant-fixture';

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
const FIELDS = { name: 'Serum', price: '₹899', description: 'Niacinamide.', language: 'en', broll: false };
const SITE = 'http://w';
const post = (body: unknown, origin: string | null = SITE) => new Request('http://w/api/jobs', { method: 'POST', body: JSON.stringify(body), ...(origin ? { headers: { origin } } : {}) });
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const appr = (origin: string | null = SITE) => new Request('http://w/api/jobs/x/variants/1/approve', { method: 'POST', ...(origin ? { headers: { origin } } : {}) });

describe('job routes (pglite, fake session)', () => {
  let h: Awaited<ReturnType<typeof openDb>>;
  let a: Tenant;
  let b: Tenant;
  let nudges = 0;
  let nudge: () => Promise<void> = async () => {};
  const storage = new LocalDiskStorage(join(mkdtempSync(join(tmpdir(), 'adforge-web-')), 'media'), 'http://pub');
  // Three distinct photos already in the (dev) store, as the browser leaves them after its PUTs.
  const stored = async () => Promise.all([1, 2, 3].map(async (i) => (await storage.put(new Uint8Array([...PNG, i]), { mime: 'image/png' })).id));
  const ctxFor = (t: Tenant | null): JobsCtx => ({
    siteUrl: SITE,
    auth: async () => (t ? { userId: t.userId, email: 'x@y.z', isAdmin: false, orgId: t.orgId } : Response.json({ error: 'unauthenticated' }, { status: 401 })),
    run: (userId, fn) => withUser(h.db, userId, fn),
    r2: false,
    storage,
    nudge: async () => { nudges++; await nudge(); },
    queue: async () => null,
  });
  beforeAll(async () => {
    h = await openDb();
    await seedVocabulary(h.db);
    a = await makeTenant(h.db);
    b = await makeTenant(h.db);
  });
  afterAll(async () => { await dropTenants(h.db, [a, b]); await h.close(); });

  it('unauthenticated -> 401 on all three', async () => {
    const c = ctxFor(null);
    expect((await createJobHandler(c, post({ ...FIELDS, photoKeys: await stored() }))).status).toBe(401);
    expect((await getJobHandler(c, a.jobId)).status).toBe(401);
    expect((await approveHandler(c, appr(), a.jobId, '1')).status).toBe(401);
  });

  it('approve of an edited revision without an export -> 409', async () => {
    const t = await makeTenant(h.db, ['completed']);
    const [v] = await h.db.select().from(variants).where(eq(variants.jobId, t.jobId));
    const row = { orgId: t.orgId, variantId: v!.id, ops: [], beats: [], spec: null, status: 'ready' as const, locked: true };
    const [r0] = await h.db.insert(variantRevisions).values({ ...row, createdAt: new Date(Date.now() - 60_000) }).returning(); // backdated: PGlite's ms clock can tie
    await h.db.insert(variantRevisions).values({ ...row, parentId: r0!.id });
    const res = await approveHandler(ctxFor(t), appr(), t.jobId, '1');
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'export the current revision before approving' });
    await dropTenants(h.db, [t]);
  });

  it('a foreign job id is 404 on GET and approve (identical to a missing id), and nothing changes', async () => {
    const c = ctxFor(a);
    const g = await getJobHandler(c, b.jobId);
    expect(g.status).toBe(404);
    expect(await g.json()).toEqual({ error: 'not found' });
    expect(await (await getJobHandler(c, randomUUID())).json()).toEqual({ error: 'not found' });
    expect((await approveHandler(c, appr(), b.jobId, '1')).status).toBe(404);
    const own = (await (await getJobHandler(ctxFor(b), b.jobId)).json()) as { variants: { status: string }[] };
    expect(own.variants.map((v) => v.status)).toEqual(['completed', 'completed', 'pending']);
    expect((await getJobHandler(c, 'not-a-uuid')).status).toBe(404);
    expect((await approveHandler(c, appr(), a.jobId, '1.5')).status).toBe(404);
  });

  it('create and approve from a foreign or missing Origin -> 403, nothing written', async () => {
    const c = ctxFor(a);
    for (const o of ['http://evil.example', null]) {
      expect((await createJobHandler(c, post({ ...FIELDS, photoKeys: await stored() }, o))).status).toBe(403);
      expect((await approveHandler(c, appr(o), a.jobId, '1')).status).toBe(403);
    }
  });

  it('approve: ok -> 200, pending -> 409', async () => {
    const c = ctxFor(a);
    const ok = await approveHandler(c, appr(), a.jobId, '1');
    expect([ok.status, await ok.json()]).toEqual([200, { approved: 1 }]);
    expect((await approveHandler(c, appr(), a.jobId, '3')).status).toBe(409);
  });

  it('POST creates the queued, undispatched job in the caller org and default project, stores assets, then nudges the dispatcher -> 202', async () => {
    const t = await makeTenant(h.db, []);
    try {
      await h.db.delete(jobs).where(eq(jobs.orgId, t.orgId));
      await h.db.delete(projects).where(eq(projects.orgId, t.orgId));
      const before = nudges;
      // The ctx has no job.requested sender at all: the dispatcher is its only sender (B4).
      const res = await createJobHandler(ctxFor(t), post({ ...FIELDS, photoKeys: await stored() }));
      expect(res.status).toBe(202);
      const { jobId } = (await res.json()) as { jobId: string };
      expect(nudges).toBe(before + 1);
      const [j] = await h.db.select().from(jobs).where(eq(jobs.id, jobId));
      const [p] = await h.db.select().from(projects).where(eq(projects.orgId, t.orgId));
      expect(j).toMatchObject({ orgId: t.orgId, userId: t.userId, projectId: p!.id, status: 'queued', dispatchedAt: null });
      expect(p!.name).toBe('Default');
      expect(await h.db.select().from(assets).where(eq(assets.orgId, t.orgId))).toHaveLength(3);
      const keys = await stored();
      expect((j!.inputSpec as { photoKeys: string[] }).photoKeys).toEqual(keys);
      const rows = await h.db.select().from(assets).where(eq(assets.orgId, t.orgId));
      expect(rows.map((r) => r.sha256).sort()).toEqual(keys.map((k) => k.slice(3, 67)).sort());
    } finally { await h.db.delete(assets).where(eq(assets.orgId, t.orgId)); await dropTenants(h.db, [t]); }
  });

  it('POST: invalid upload -> 400; a failing or hanging nudge still -> 202 with the job queued (the cron dispatches it)', async () => {
    expect((await createJobHandler(ctxFor(a), post({ ...FIELDS, photoKeys: [] }))).status).toBe(400);
    const t = await makeTenant(h.db, []);
    try {
      for (const n of [async () => { throw new Error('inngest down'); }, () => new Promise<void>(() => {})]) {
        nudge = n;
        const t0 = Date.now();
        const res = await createJobHandler(ctxFor(t), post({ ...FIELDS, photoKeys: await stored() }));
        expect(Date.now() - t0).toBeLessThan(NUDGE_TIMEOUT_MS + 1_000);
        expect(res.status).toBe(202);
        const { jobId } = (await res.json()) as { jobId: string };
        const [j] = await h.db.select().from(jobs).where(eq(jobs.id, jobId));
        expect(j).toMatchObject({ status: 'queued', dispatchedAt: null });
      }
    } finally { nudge = async () => {}; await h.db.delete(assets).where(eq(assets.orgId, t.orgId)); await dropTenants(h.db, [t]); }
  });
});

describe('job create: key ownership (prod store)', () => {
  let h: Awaited<ReturnType<typeof openDb>>;
  let a: Tenant;
  let b: Tenant;
  beforeAll(async () => { h = await openDb(); await seedVocabulary(h.db); a = await makeTenant(h.db, []); b = await makeTenant(h.db, []); });
  afterAll(async () => { await dropTenants(h.db, [a, b]); await h.close(); });
  const present = new Set<string>();
  const keyFor = (org: string, i: number) => { const s = sha(new Uint8Array([i])); return `org/${org}/${s.slice(0, 2)}/${s}.png`; };
  const ctx = (t: Tenant): JobsCtx => ({
    siteUrl: SITE, r2: true,
    auth: async () => ({ userId: t.userId, email: 'x@y.z', isAdmin: false, orgId: t.orgId }),
    run: (userId, fn) => withUser(h.db, userId, fn),
    storage: { id: 'r2', urlFor: (k: string) => `http://pub/media/${k}`, head: async (k: string) => (present.has(k) ? { bytes: 9, mime: 'image/png' } : null) } as never,
    queue: async () => null,
    nudge: async () => {},
  });
  const counts = async (t: Tenant) => [(await h.db.select().from(assets).where(eq(assets.orgId, t.orgId))).length, (await h.db.select().from(jobs).where(eq(jobs.orgId, t.orgId))).length];

  it('a key under another org -> 403, no asset or job rows', async () => {
    const keys = [1, 2, 3].map((i) => keyFor(i === 2 ? b.orgId : a.orgId, i));
    keys.forEach((k) => present.add(k));
    const before = await counts(a);
    const r = await createJobHandler(ctx(a), post({ ...FIELDS, photoKeys: keys }));
    expect([r.status, await r.json()]).toEqual([403, { error: 'photo key belongs to another account' }]);
    expect(await counts(a)).toEqual(before);
  });
  it('a dev-shaped key, or a key whose shard does not match its sha -> 403', async () => {
    const s = sha(new Uint8Array([7]));
    const good = [1, 2].map((i) => keyFor(a.orgId, i));
    good.forEach((k) => present.add(k));
    for (const bad of [`${s.slice(0, 2)}/${s}.png`, `org/${a.orgId}/${s[0] === '0' ? '1' : '0'}${s[1]}/${s}.png`]) {
      present.add(bad);
      expect((await createJobHandler(ctx(a), post({ ...FIELDS, photoKeys: [...good, bad] }))).status).toBe(403);
    }
  });
  it('a key head() says is missing -> 400 "photo 2 was not uploaded", no rows', async () => {
    const keys = [11, 12, 13].map((i) => keyFor(a.orgId, i));
    present.add(keys[0]!); present.add(keys[2]!);
    const before = await counts(a);
    const r = await createJobHandler(ctx(a), post({ ...FIELDS, photoKeys: keys }));
    expect([r.status, await r.json()]).toEqual([400, { error: 'photo 2 was not uploaded' }]);
    expect(await counts(a)).toEqual(before);
  });
  it('a stored object over 10 MB or of another type -> 400, no rows', async () => {
    const keys = [21, 22, 23].map((i) => keyFor(a.orgId, i));
    keys.forEach((k) => present.add(k));
    const big = ctx(a);
    big.storage = { ...(big.storage as object), head: async (k: string) => ({ bytes: k === keys[1] ? 11 * 1024 * 1024 : 9, mime: 'image/png' }) } as never;
    const before = await counts(a);
    expect((await createJobHandler(big, post({ ...FIELDS, photoKeys: keys }))).status).toBe(400);
    expect(await counts(a)).toEqual(before);
    const wrong = ctx(a);
    wrong.storage = { ...(wrong.storage as object), head: async () => ({ bytes: 9, mime: 'video/mp4' }) } as never;
    expect((await createJobHandler(wrong, post({ ...FIELDS, photoKeys: keys }))).status).toBe(400);
    expect(await counts(a)).toEqual(before);
  });
  it('happy path: own org keys -> 202, asset sha256 from the key', async () => {
    const t = await makeTenant(h.db, []);
    try {
      const keys = [31, 32, 33].map((i) => keyFor(t.orgId, i));
      keys.forEach((k) => present.add(k));
      const r = await createJobHandler(ctx(t), post({ ...FIELDS, photoKeys: keys }));
      expect(r.status).toBe(202);
      expect((await h.db.select().from(assets).where(eq(assets.orgId, t.orgId))).map((x) => x.storageKey).sort()).toEqual([...keys].sort());
    } finally { await dropTenants(h.db, [t]); }
  });
});

describe('route-level guards and retry', () => {
  const base = { r2: false, siteUrl: SITE, auth: async () => ({ userId: 'u', email: 'e', isAdmin: false, orgId: 'o' }), storage: {} as never, nudge: async () => {}, queue: async () => null };
  it('declared Content-Length over 16 KB -> 413 before parsing', async () => {
    const ctx: JobsCtx = { ...base, run: async () => { throw new Error('must not touch the db'); } };
    const res = await createJobHandler(ctx, new Request('http://w/api/jobs', { method: 'POST', body: 'x', headers: { origin: SITE, 'content-length': String(17 * 1024) } }));
    expect(res.status).toBe(413);
  });
  it('a chunked (no Content-Length) job body over 16 KB -> 413', async () => {
    const ctx: JobsCtx = { ...base, run: async () => { throw new Error('must not touch the db'); } };
    const body = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('x'.repeat(20 * 1024))); c.close(); } });
    const res = await createJobHandler(ctx, new Request('http://w/api/jobs', { method: 'POST', body, headers: { origin: SITE }, duplex: 'half' } as RequestInit));
    expect(res.status).toBe(413);
  });
  it('approve retries once on a deadlock (40P01, even wrapped) and then succeeds', async () => {
    let calls = 0;
    const ctx: JobsCtx = { ...base, run: async () => { if (++calls === 1) throw Object.assign(new Error('failed query'), { cause: { code: '40P01' } }); return 'ok' as never; } };
    const res = await approveHandler(ctx, appr(), randomUUID(), '2');
    expect([res.status, calls]).toEqual([200, 2]);
  });
  it('approve retries only once, and not for other errors', async () => {
    let calls = 0;
    const dead: JobsCtx = { ...base, run: async () => { calls++; throw Object.assign(new Error('x'), { code: '40001' }); } };
    await expect(approveHandler(dead, appr(), randomUUID(), '2')).rejects.toThrow();
    expect(calls).toBe(2);
    calls = 0;
    const other: JobsCtx = { ...base, run: async () => { calls++; throw new Error('boom'); } };
    await expect(approveHandler(other, appr(), randomUUID(), '2')).rejects.toThrow('boom');
    expect(calls).toBe(1);
  });
});

describe('requireApiUserWith', () => {
  const supa = (r: unknown) => ({ auth: { getClaims: async () => r as never } });
  const ok = { sub: randomUUID(), email: 'A@B.test' };
  it('no/forged claims -> 401 JSON, not a redirect', async () => {
    const r = await requireApiUserWith({ supabase: supa({ data: null, error: new Error('bad jwt') }), provision: async () => ({ isAdmin: false, orgId: 'o' }) });
    expect(r).toBeInstanceOf(Response);
    expect((r as Response).status).toBe(401);
  });
  it('refusals map to 403 / 409; success carries the orgId', async () => {
    const claims = supa({ data: { claims: ok }, error: null });
    const refuse = (reason: 'not-invited' | 'conflict') => requireApiUserWith({ supabase: claims, provision: async () => { throw new ProvisionRefused(reason); } });
    expect(((await refuse('not-invited')) as Response).status).toBe(403);
    expect(((await refuse('conflict')) as Response).status).toBe(409);
    expect(await requireApiUserWith({ supabase: claims, provision: async () => ({ isAdmin: false, orgId: 'org1' }) })).toEqual({ userId: ok.sub, email: 'a@b.test', isAdmin: false, orgId: 'org1' });
  });
});

describe('job view queue (pglite, fake session)', () => {
  let h: Awaited<ReturnType<typeof openDb>>;
  let a: Tenant;
  let b: Tenant;
  const storage = new LocalDiskStorage(join(mkdtempSync(join(tmpdir(), 'adforge-web-q-')), 'media'), 'http://pub');
  const ctxFor = (t: Tenant, queue: JobsCtx['queue']): JobsCtx => ({
    siteUrl: SITE,
    auth: async () => ({ userId: t.userId, email: 'x@y.z', isAdmin: false, orgId: t.orgId }),
    run: (userId, fn) => withUser(h.db, userId, fn),
    r2: false,
    storage,
    nudge: async () => {},
    queue,
  });
  beforeAll(async () => {
    h = await openDb();
    await seedVocabulary(h.db);
    a = await makeTenant(h.db);
    b = await makeTenant(h.db);
  });
  afterAll(async () => { await dropTenants(h.db, [a, b]); await h.close(); });

  it('Review Focus 5: GET includes queue and contains no other job id or org id', async () => {
    const seen: string[] = [];
    const res = await getJobHandler(ctxFor(a, async (id) => { seen.push(id); return { position: 2, etaRange: [720, 1200] }; }), a.jobId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { job: { id: string }; queue: unknown };
    expect(body.queue).toEqual({ position: 2, etaRange: [720, 1200] });
    expect(seen).toEqual([a.jobId]);
    const dumped = JSON.stringify(body);
    expect(dumped).toContain(a.jobId);
    expect(dumped).not.toContain(b.jobId);
    expect(dumped).not.toContain(b.orgId);
    expect(dumped).not.toContain(a.orgId);
  });

  it('GET returns queue null when the owner call says the job is not queued or running', async () => {
    const res = await getJobHandler(ctxFor(a, async () => null), a.jobId);
    expect(res.status).toBe(200);
    expect((await res.json() as { queue: unknown }).queue).toBeNull();
  });
});
