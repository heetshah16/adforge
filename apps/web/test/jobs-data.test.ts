import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDb } from '@adforge/db/client';
import { seedVocabulary } from '@adforge/db/seed/seed';
import { jobs, projects } from '@adforge/db/schema';
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
