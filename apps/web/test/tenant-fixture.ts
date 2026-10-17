import { randomUUID } from 'node:crypto';
import { inArray } from 'drizzle-orm';
import type { Db } from '@adforge/db/client';
import { assets, jobs, memberships, orgs, projects, users, variants } from '@adforge/db/schema';

export type Tenant = { orgId: string; userId: string; projectId: string; jobId: string };
/** One org with a member, a project, a job and variants 1..statuses.length (owner connection, as the worker would). */
export async function makeTenant(db: Db, statuses: ('pending' | 'running' | 'completed' | 'failed' | 'approved')[] = ['completed', 'completed', 'pending']): Promise<Tenant> {
  const t = { orgId: randomUUID(), userId: randomUUID(), projectId: randomUUID(), jobId: randomUUID() };
  await db.insert(orgs).values({ id: t.orgId, name: `t-${t.orgId}` });
  await db.insert(users).values({ id: t.userId, email: `${t.userId}@jobs.test` });
  await db.insert(memberships).values({ orgId: t.orgId, userId: t.userId, role: 'owner' });
  await db.insert(projects).values({ id: t.projectId, orgId: t.orgId, userId: t.userId, name: 'Default' });
  await db.insert(jobs).values({ id: t.jobId, orgId: t.orgId, projectId: t.projectId, userId: t.userId, inputSpec: {} });
  if (statuses.length) await db.insert(variants).values(statuses.map((status, i) => ({
    orgId: t.orgId, jobId: t.jobId, variantNo: i + 1, formatSlug: 'f', hookSlug: 'h', archetypeSlug: 'a', visualTreatment: 'v', strategicBet: 'b', status,
  })));
  return t;
}
export async function dropTenants(db: Db, ts: Tenant[]) {
  const o = ts.map((t) => t.orgId);
  if (!o.length) return;
  await db.delete(variants).where(inArray(variants.orgId, o));
  await db.delete(jobs).where(inArray(jobs.orgId, o));
  await db.delete(assets).where(inArray(assets.orgId, o));
  await db.delete(projects).where(inArray(projects.orgId, o));
  await db.delete(memberships).where(inArray(memberships.orgId, o));
  await db.delete(users).where(inArray(users.id, ts.map((t) => t.userId)));
  await db.delete(orgs).where(inArray(orgs.id, o));
}

