import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { loadRegistry } from '@adforge/db/registry';
import { assets, jobs, projects, variants, type ProgressEntry } from '@adforge/db/schema';
import type { UserDb } from '@adforge/db/with-user';

/** Everything here takes a UserDb: RLS decides what exists. A foreign id looks exactly like a missing one. */
export type JobView = {
  job: { id: string; status: 'queued' | 'running' | 'completed' | 'failed'; progress: ProgressEntry[]; brief: unknown; error: unknown; costUsd: number; createdAt: string; completedAt: string | null };
  variants: {
    variantNo: number; formatSlug: string; formatFamily: string | null; hookSlug: string; hookFamily: string | null; visualTreatment: string;
    strategicBet: string; isExploratory: boolean; status: 'pending' | 'running' | 'completed' | 'failed' | 'approved'; error: unknown; renderUrl: string | null;
  }[];
};

// ponytail: select-then-insert; two simultaneous first uploads can make two 'Default' projects (harmless, the oldest wins). Add a unique (org_id, name) if it ever matters.
export async function ensureDefaultProject(udb: UserDb, { orgId, userId }: { orgId: string; userId: string }): Promise<string> {
  const [p] = await udb.select({ id: projects.id }).from(projects).where(and(eq(projects.orgId, orgId), eq(projects.name, 'Default'))).orderBy(asc(projects.createdAt)).limit(1);
  if (p) return p.id;
  const [created] = await udb.insert(projects).values({ orgId, userId, name: 'Default' }).returning({ id: projects.id });
  return created!.id;
}

export async function createJobRow(udb: UserDb, v: { orgId: string; projectId: string; userId: string; inputSpec: unknown }): Promise<string> {
  const [j] = await udb.insert(jobs).values(v).returning({ id: jobs.id });
  return j!.id;
}

export async function getJobView(udb: UserDb, jobId: string, mediaUrl: (storageKey: string) => string): Promise<JobView | null> {
  const [j] = await udb.select().from(jobs).where(eq(jobs.id, jobId));
  if (!j) return null;
  const vs = await udb.select().from(variants).leftJoin(assets, eq(variants.renderAssetId, assets.id)).where(eq(variants.jobId, jobId));
  const registry = await loadRegistry(udb);
  return {
    job: { id: j.id, status: j.status, progress: j.progress, brief: j.brief, error: j.error, costUsd: j.costUsd, createdAt: j.createdAt.toISOString(), completedAt: j.completedAt?.toISOString() ?? null },
    variants: vs
      .map(({ variants: v, assets: a }) => ({
        variantNo: v.variantNo, formatSlug: v.formatSlug, hookSlug: v.hookSlug, visualTreatment: v.visualTreatment,
        strategicBet: v.strategicBet, isExploratory: v.isExploratory, status: v.status, error: v.error,
        formatFamily: registry.formats.find((f) => f.slug === v.formatSlug)?.family ?? null,
        hookFamily: registry.hooks.find((h) => h.slug === v.hookSlug)?.family ?? null,
        renderUrl: a ? mediaUrl(a.storageKey) : null,
      }))
      .sort((x, y) => x.variantNo - y.variantNo),
  };
}

/**
 * One UPDATE: the target becomes approved, every other approved/completed variant of the job becomes completed, only if the target is
 * completed or approved. It deliberately writes every completed/approved row of the job (not just the changed ones): two concurrent
 * approves then contend for the same row locks, and the loser re-evaluates its SET and WHERE against the winner's committed row
 * (READ COMMITTED), so it demotes the winner. Touching only changed rows would let both commit and leave two approved.
 */
export async function approveVariant(udb: UserDb, jobId: string, n: number): Promise<'ok' | 'not_found' | 'conflict'> {
  const eligible = inArray(variants.status, ['completed', 'approved']);
  const done = await udb
    .update(variants)
    .set({ status: sql`case when ${variants.variantNo} = ${n} then 'approved'::variant_status else 'completed'::variant_status end` })
    .where(and(eq(variants.jobId, jobId), eligible, sql`exists (select 1 from variants t where t.job_id = ${jobId} and t.variant_no = ${n} and t.status in ('completed', 'approved'))`))
    .returning({ variantNo: variants.variantNo });
  if (done.some((r) => r.variantNo === n)) return 'ok';
  const [t] = await udb.select({ id: variants.id }).from(variants).where(and(eq(variants.jobId, jobId), eq(variants.variantNo, n)));
  return t ? 'conflict' : 'not_found';
}
