import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDb } from '@adforge/db/client';
import { seedVocabulary } from '@adforge/db/seed/seed';
import { assets, jobs, projects } from '@adforge/db/schema';
import { withUser } from '@adforge/db/with-user';
import { LocalDiskStorage } from '@adforge/provider-local-storage';
import { approveHandler, createJobHandler, getJobHandler, type JobsCtx } from '../lib/server/jobs-api';
import { requireApiUserWith } from '../lib/server/session';
import { ProvisionRefused } from '../lib/server/provision-owner';
import { dropTenants, makeTenant, type Tenant } from './tenant-fixture';

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
const form = () => {
  const f = new FormData();
  for (const [k, v] of Object.entries({ name: 'Serum', price: '₹899', description: 'Niacinamide.', language: 'en' })) f.append(k, v);
  for (const i of [1, 2, 3]) f.append('photos', new File([new Uint8Array([...PNG, i])], 'p.png', { type: 'image/png' }));
  return f;
};
const post = (body: FormData) => new Request('http://w/api/jobs', { method: 'POST', body });

describe('job routes (pglite, fake session)', () => {
  let h: Awaited<ReturnType<typeof openDb>>;
  let a: Tenant;
  let b: Tenant;
  const sent: string[] = [];
  const failed: string[] = [];
  let sendError: Error | undefined;
  const ctxFor = (t: Tenant | null): JobsCtx => ({
    auth: async () => (t ? { userId: t.userId, email: 'x@y.z', isAdmin: false, orgId: t.orgId } : Response.json({ error: 'unauthenticated' }, { status: 401 })),
    run: (userId, fn) => withUser(h.db, userId, fn),
    storage: new LocalDiskStorage(join(mkdtempSync(join(tmpdir(), 'adforge-web-')), 'media'), 'http://pub'),
    send: async (id) => { if (sendError) throw sendError; sent.push(id); },
    fail: async (id) => { failed.push(id); },
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
    expect((await createJobHandler(c, post(form()))).status).toBe(401);
    expect((await getJobHandler(c, a.jobId)).status).toBe(401);
    expect((await approveHandler(c, a.jobId, '1')).status).toBe(401);
  });

  it('a foreign job id is 404 on GET and approve (identical to a missing id), and nothing changes', async () => {
    const c = ctxFor(a);
    const g = await getJobHandler(c, b.jobId);
    expect(g.status).toBe(404);
    expect(await g.json()).toEqual({ error: 'not found' });
    expect(await (await getJobHandler(c, randomUUID())).json()).toEqual({ error: 'not found' });
    expect((await approveHandler(c, b.jobId, '1')).status).toBe(404);
    const own = (await (await getJobHandler(ctxFor(b), b.jobId)).json()) as { variants: { status: string }[] };
    expect(own.variants.map((v) => v.status)).toEqual(['completed', 'completed', 'pending']);
    expect((await getJobHandler(c, 'not-a-uuid')).status).toBe(404);
    expect((await approveHandler(c, a.jobId, '1.5')).status).toBe(404);
  });

  it('approve: ok -> 200, pending -> 409', async () => {
    const c = ctxFor(a);
    const ok = await approveHandler(c, a.jobId, '1');
    expect([ok.status, await ok.json()]).toEqual([200, { approved: 1 }]);
    expect((await approveHandler(c, a.jobId, '3')).status).toBe(409);
  });

  it('POST creates the job in the caller org and default project, stores assets, then sends the event -> 202', async () => {
    const t = await makeTenant(h.db, []);
    try {
      await h.db.delete(jobs).where(eq(jobs.orgId, t.orgId));
      await h.db.delete(projects).where(eq(projects.orgId, t.orgId));
      const res = await createJobHandler(ctxFor(t), post(form()));
      expect(res.status).toBe(202);
      const { jobId } = (await res.json()) as { jobId: string };
      expect(sent).toContain(jobId);
      const [j] = await h.db.select().from(jobs).where(eq(jobs.id, jobId));
      const [p] = await h.db.select().from(projects).where(eq(projects.orgId, t.orgId));
      expect(j).toMatchObject({ orgId: t.orgId, userId: t.userId, projectId: p!.id, status: 'queued' });
      expect(p!.name).toBe('Default');
      expect(await h.db.select().from(assets).where(eq(assets.orgId, t.orgId))).toHaveLength(3);
      expect((j!.inputSpec as { photoKeys: string[] }).photoKeys).toHaveLength(3);
    } finally { await h.db.delete(assets).where(eq(assets.orgId, t.orgId)); await dropTenants(h.db, [t]); }
  });

  it('POST: invalid upload -> 400; send failure -> 503 and the job is failed', async () => {
    const bad = form();
    bad.delete('photos');
    expect((await createJobHandler(ctxFor(a), post(bad))).status).toBe(400);
    const t = await makeTenant(h.db, []);
    try {
      sendError = new Error('inngest down');
      const res = await createJobHandler(ctxFor(t), post(form()));
      expect([res.status, await res.json()]).toEqual([503, { error: 'could not queue the job' }]);
      const created = (await h.db.select({ id: jobs.id }).from(jobs).where(eq(jobs.orgId, t.orgId))).find((j) => j.id !== t.jobId);
      expect(created).toBeDefined();
      expect(failed).toEqual([created!.id]);
    } finally { sendError = undefined; await h.db.delete(assets).where(eq(assets.orgId, t.orgId)); await dropTenants(h.db, [t]); }
  });
});

describe('route-level guards and retry', () => {
  const base = { auth: async () => ({ userId: 'u', email: 'e', isAdmin: false, orgId: 'o' }), storage: {} as never, send: async () => {}, fail: async () => {} };
  it('declared Content-Length over 30 MB -> 413 before parsing', async () => {
    const ctx: JobsCtx = { ...base, run: async () => { throw new Error('must not touch the db'); } };
    const res = await createJobHandler(ctx, new Request('http://w/api/jobs', { method: 'POST', body: 'x', headers: { 'content-length': String(31 * 1024 * 1024) } }));
    expect(res.status).toBe(413);
  });
  it('approve retries once on a deadlock (40P01, even wrapped) and then succeeds', async () => {
    let calls = 0;
    const ctx: JobsCtx = { ...base, run: async () => { if (++calls === 1) throw Object.assign(new Error('failed query'), { cause: { code: '40P01' } }); return 'ok' as never; } };
    const res = await approveHandler(ctx, randomUUID(), '2');
    expect([res.status, calls]).toEqual([200, 2]);
  });
  it('approve retries only once, and not for other errors', async () => {
    let calls = 0;
    const dead: JobsCtx = { ...base, run: async () => { calls++; throw Object.assign(new Error('x'), { code: '40001' }); } };
    await expect(approveHandler(dead, randomUUID(), '2')).rejects.toThrow();
    expect(calls).toBe(2);
    calls = 0;
    const other: JobsCtx = { ...base, run: async () => { calls++; throw new Error('boom'); } };
    await expect(approveHandler(other, randomUUID(), '2')).rejects.toThrow('boom');
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
