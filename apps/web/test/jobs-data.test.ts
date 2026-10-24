import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDb } from '@adforge/db/client';
import { seedVocabulary } from '@adforge/db/seed/seed';
import { assets, jobs, projects, variantRevisions, variants } from '@adforge/db/schema';
import { compileProject } from '@adforge/core/project';
import { specKeys } from '@adforge/renderer-hyperframes/compose';
import { compileBeats, compileVariant } from './compile-fixture';
import { withUser } from '@adforge/db/with-user';
import { approveVariant, createJobRow, ensureDefaultProject, getJobView } from '../lib/data/jobs';
import { dropTenants, makeTenant, type Tenant } from './tenant-fixture';

describe('jobs data under RLS (pglite)', () => {
  let h: Awaited<ReturnType<typeof openDb>>;
  let a: Tenant;
  let b: Tenant;
  beforeAll(async () => {
    h = await openDb();
    await seedVocabulary(h.db);
    a = await makeTenant(h.db);
    b = await makeTenant(h.db);
  });
  afterAll(() => h.close());
  const url = (k: string) => `http://pub/media/${k}`;

  it('getJobView: own job -> view; foreign org job -> null; unknown id -> null', async () => {
    const own = await withUser(h.db, a.userId, (u) => getJobView(u, a.jobId, url));
    expect(own).toMatchObject({ job: { id: a.jobId, status: 'queued', costUsd: 0 }, variants: [{ variantNo: 1, status: 'completed', renderUrl: null }, { variantNo: 2 }, { variantNo: 3 }] });
    expect(typeof own!.job.createdAt).toBe('string');
    expect(await withUser(h.db, a.userId, (u) => getJobView(u, b.jobId, url))).toBeNull();
    expect(await withUser(h.db, a.userId, (u) => getJobView(u, randomUUID(), url))).toBeNull();
  });

  it('getJobView: the current revision (spec + asset urls) for a ready variant; none for a legacy one; no spec while pending; failed edits skipped', async () => {
    const t = await makeTenant(h.db, ['completed', 'completed', 'completed']);
    const vs = await h.db.select().from(variants).where(eq(variants.jobId, t.jobId));
    const [v1, v2, v3] = [1, 2, 3].map((n) => vs.find((v) => v.variantNo === n)!);
    const base = { id: 'x', variant: compileVariant(), theme: { primary: '#141414', accent: '#f5b301' } };
    const spec = compileProject({ base, ops: [] }, compileBeats()).spec;
    const row = { orgId: t.orgId, ops: [], beats: [], spec, status: 'ready' as const, locked: true };
    const [r0] = await h.db.insert(variantRevisions).values({ ...row, variantId: v1!.id }).returning();
    await h.db.insert(variantRevisions).values({ ...row, variantId: v1!.id, parentId: r0!.id, status: 'failed', spec: null, locked: false });
    await h.db.insert(variantRevisions).values({ ...row, variantId: v3!.id, status: 'pending', spec: null, locked: false });
    const got = (await withUser(h.db, t.userId, (u) => getJobView(u, t.jobId, url)))!.variants;
    expect(got[0]!.revision).toMatchObject({ id: r0!.id, status: 'ready', locked: true, spec });
    expect(Object.keys(got[0]!.revision!.assetUrls).sort()).toEqual(specKeys(spec).sort());
    expect(got[0]!.revision!.assetUrls[specKeys(spec)[0]!]).toBe(url(specKeys(spec)[0]!));
    expect(got[1]!.revision).toBeNull(); // legacy: no revisions
    expect(got[2]!.revision).toMatchObject({ status: 'pending', spec: null, assetUrls: {} });
    void v2;
    await dropTenants(h.db, [t]);
  });

  it('I1: renderUrl prefers the current revision export; approving an edited revision needs it (revision 0 approves as before)', async () => {
    const t = await makeTenant(h.db, ['completed', 'completed']);
    const vs = await h.db.select().from(variants).where(eq(variants.jobId, t.jobId));
    const [v1, v2] = [1, 2].map((n) => vs.find((v) => v.variantNo === n)!);
    const spec = compileProject({ base: { id: 'x', variant: compileVariant(), theme: { primary: '#141414', accent: '#f5b301' } }, ops: [] }, compileBeats()).spec;
    const asset = async (key: string) => (await h.db.insert(assets).values({ orgId: t.orgId, projectId: t.projectId, kind: 'render', storageKey: key, mime: 'video/mp4', bytes: 1, sha256: key }).returning())[0]!;
    const orig = await asset('orig.mp4'), exp = await asset('edited.mp4');
    await h.db.update(variants).set({ renderAssetId: orig.id }).where(eq(variants.jobId, t.jobId));
    const row = { orgId: t.orgId, ops: [], beats: [], spec, status: 'ready' as const, locked: true };
    const [r0] = await h.db.insert(variantRevisions).values({ ...row, variantId: v1!.id }).returning();
    await h.db.insert(variantRevisions).values({ ...row, variantId: v2!.id });
    const view = async () => (await withUser(h.db, t.userId, (u) => getJobView(u, t.jobId, url)))!.variants;
    expect((await view())[0]!.renderUrl).toBe(url('orig.mp4')); // revision 0 has no render asset: falls back
    expect(await withUser(h.db, t.userId, (u) => approveVariant(u, t.jobId, 1))).toBe('ok'); // rev 0 approves as before
    const [r1] = await h.db.insert(variantRevisions).values({ ...row, variantId: v1!.id, parentId: r0!.id }).returning();
    expect(await withUser(h.db, t.userId, (u) => approveVariant(u, t.jobId, 1))).toBe('unexported');
    await h.db.update(variantRevisions).set({ renderAssetId: exp.id }).where(eq(variantRevisions.id, r1!.id));
    expect((await view())[0]!.renderUrl).toBe(url('edited.mp4'));
    expect((await view())[1]!.renderUrl).toBe(url('orig.mp4'));
    expect(await withUser(h.db, t.userId, (u) => approveVariant(u, t.jobId, 1))).toBe('ok');
    await dropTenants(h.db, [t]);
  });

  it('M8: one corrupt revision spec does not take down the job view', async () => {
    const t = await makeTenant(h.db, ['completed', 'completed']);
    const vs = await h.db.select().from(variants).where(eq(variants.jobId, t.jobId));
    await h.db.insert(variantRevisions).values({ orgId: t.orgId, variantId: vs[0]!.id, ops: [], beats: [], spec: { nope: true }, status: 'ready', locked: true });
    const got = (await withUser(h.db, t.userId, (u) => getJobView(u, t.jobId, url)))!.variants;
    expect(got).toHaveLength(2);
    expect(got.every((v) => v.revision === null)).toBe(true);
    await dropTenants(h.db, [t]);
  });

  it('approveVariant: foreign -> not_found, pending -> conflict, completed -> ok with exactly one approved', async () => {
    expect(await withUser(h.db, a.userId, (u) => approveVariant(u, b.jobId, 1))).toBe('not_found');
    expect(await withUser(h.db, a.userId, (u) => approveVariant(u, a.jobId, 9))).toBe('not_found');
    expect(await withUser(h.db, a.userId, (u) => approveVariant(u, a.jobId, 3))).toBe('conflict');
    expect(await withUser(h.db, a.userId, (u) => approveVariant(u, a.jobId, 1))).toBe('ok');
    expect(await withUser(h.db, a.userId, (u) => approveVariant(u, a.jobId, 2))).toBe('ok');
    expect(await withUser(h.db, a.userId, (u) => approveVariant(u, a.jobId, 2))).toBe('ok'); // idempotent
    const st = (await withUser(h.db, a.userId, (u) => getJobView(u, a.jobId, url)))!.variants.map((v) => v.status);
    expect(st).toEqual(['completed', 'approved', 'pending']);
    // the foreign job is untouched
    expect((await withUser(h.db, b.userId, (u) => getJobView(u, b.jobId, url)))!.variants.map((v) => v.status)).toEqual(['completed', 'completed', 'pending']);
  });

  it('ensureDefaultProject creates once, then reuses; createJobRow inserts under the caller', async () => {
    const t = await makeTenant(h.db, []);
    await h.db.delete(jobs).where(eq(jobs.orgId, t.orgId));
    await h.db.delete(projects).where(eq(projects.orgId, t.orgId));
    const p1 = await withUser(h.db, t.userId, (u) => ensureDefaultProject(u, { orgId: t.orgId, userId: t.userId }));
    const p2 = await withUser(h.db, t.userId, (u) => ensureDefaultProject(u, { orgId: t.orgId, userId: t.userId }));
    expect(p2).toBe(p1);
    const parallel = await Promise.all([1, 2, 3].map(() => withUser(h.db, t.userId, (u) => ensureDefaultProject(u, { orgId: t.orgId, userId: t.userId }))));
    expect(new Set(parallel)).toEqual(new Set([p1]));
    const id = await withUser(h.db, t.userId, (u) => createJobRow(u, { orgId: t.orgId, projectId: p1, userId: t.userId, inputSpec: { x: 1 } }));
    expect((await withUser(h.db, t.userId, (u) => getJobView(u, id, url)))!.job.status).toBe('queued');
    // a member of another org cannot create a job in this org's project
    await expect(withUser(h.db, a.userId, (u) => createJobRow(u, { orgId: t.orgId, projectId: p1, userId: a.userId, inputSpec: {} }))).rejects.toThrow();
    await dropTenants(h.db, [t]);
  });
});
