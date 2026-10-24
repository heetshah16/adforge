import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { loadRegistry } from '@adforge/db/registry';
import { assets, jobs, projects, variantRevisions, variants } from '@adforge/db/schema';
import type { Db } from '@adforge/db/client';
import type { UserDb } from '@adforge/db/with-user';
import { readSpec } from '@adforge/core/spec/upgrade-spec';
import { specKeys } from '@adforge/renderer-hyperframes/compose';
import type { JobView } from '../api';

/** Everything here takes a UserDb: RLS decides what exists. A foreign id looks exactly like a missing one. */

/** unique (org_id, name) makes concurrent first uploads converge on one 'Default'. */
export async function ensureDefaultProject(udb: UserDb, { orgId, userId }: { orgId: string; userId: string }): Promise<string> {
  const find = () => udb.select({ id: projects.id }).from(projects).where(and(eq(projects.orgId, orgId), eq(projects.name, 'Default'))).limit(1);
  const [p] = await find();
  if (p) return p.id;
  // A conflicting concurrent insert blocks until that transaction commits, then DO NOTHING; the re-select (READ COMMITTED) sees its row.
  await udb.insert(projects).values({ orgId, userId, name: 'Default' }).onConflictDoNothing();
  return (await find())[0]!.id;
}

export async function createJobRow(udb: UserDb, v: { orgId: string; projectId: string; userId: string; inputSpec: unknown }): Promise<string> {
  const [j] = await udb.insert(jobs).values(v).returning({ id: jobs.id });
  return j!.id;
}

function revisionView(r: Awaited<ReturnType<typeof currentRevision>>, mediaUrl: (storageKey: string) => string): JobView['variants'][number]['revision'] {
  if (!r) return null;
  const spec = r.status === 'ready' ? readSpec(r.spec) : null;
  return { id: r.id, status: r.status, locked: r.locked, needsExport: !!r.parentId && !r.renderAssetId, spec, assetUrls: spec ? Object.fromEntries(specKeys(spec).map((k) => [k, mediaUrl(k)])) : {} };
}

export async function getJobView(udb: UserDb, jobId: string, mediaUrl: (storageKey: string) => string): Promise<JobView | null> {
  const [j] = await udb.select().from(jobs).where(eq(jobs.id, jobId));
  if (!j) return null;
  const vs = await udb.select().from(variants).leftJoin(assets, eq(variants.renderAssetId, assets.id)).where(eq(variants.jobId, jobId));
  const registry = await loadRegistry(udb);
  const revisions = new Map(await Promise.all(vs.map(async ({ variants: v }) => {
    const r = await currentRevision(udb, v.id);
    // I1: an edited export is what the variant delivers; falls back to the original render until it is exported.
    const [ra] = r?.renderAssetId ? await udb.select({ storageKey: assets.storageKey }).from(assets).where(eq(assets.id, r.renderAssetId)) : [];
    // M8: one corrupt revision spec must not take down the whole job view; that variant just shows no revision.
    let view: ReturnType<typeof revisionView> = null;
    try { view = revisionView(r, mediaUrl); } catch (e) { console.error(`getJobView: variant ${v.id} revision ${r?.id} unreadable`, e); }
    return [v.id, { view, renderUrl: ra ? mediaUrl(ra.storageKey) : null }] as const;
  })));
  return {
    job: { id: j.id, status: j.status, progress: j.progress, brief: j.brief, error: j.error, costUsd: j.costUsd, createdAt: j.createdAt.toISOString(), completedAt: j.completedAt?.toISOString() ?? null },
    variants: vs
      .map(({ variants: v, assets: a }) => ({
        variantNo: v.variantNo, formatSlug: v.formatSlug, hookSlug: v.hookSlug, visualTreatment: v.visualTreatment,
        strategicBet: v.strategicBet, isExploratory: v.isExploratory, status: v.status, error: v.error,
        formatFamily: registry.formats.find((f) => f.slug === v.formatSlug)?.family ?? null,
        hookFamily: registry.hooks.find((h) => h.slug === v.hookSlug)?.family ?? null,
        renderUrl: revisions.get(v.id)?.renderUrl ?? (a ? mediaUrl(a.storageKey) : null),
        revision: revisions.get(v.id)?.view ?? null,
      }))
      .sort((x, y) => x.variantNo - y.variantNo),
  };
}

/** The newest non-failed revision by created_at (ties by id), or undefined for a legacy variant that has none. A failed edit never blocks approving the last good one. Takes a Db because a UserDb is one: the approve path passes a UserDb, the owner-side tests a plain Db. */
export async function currentRevision(db: Db, variantId: string) {
  const [r] = await db.select().from(variantRevisions).where(and(eq(variantRevisions.variantId, variantId), ne(variantRevisions.status, 'failed'))).orderBy(desc(variantRevisions.createdAt), desc(variantRevisions.id)).limit(1);
  return r;
}

/**
 * One UPDATE: the target becomes approved, every other approved/completed variant of the job becomes completed, only if the target is
 * completed or approved. It deliberately writes every completed/approved row of the job (not just the changed ones): two concurrent
 * approves then contend for the same row locks, and the loser re-evaluates its SET and WHERE against the winner's committed row
 * (READ COMMITTED), so it demotes the winner. Touching only changed rows would let both commit and leave two approved.
 */
export async function approveVariant(udb: UserDb, jobId: string, n: number): Promise<'ok' | 'not_found' | 'conflict' | 'unlocked' | 'unexported'> {
  // A variant with revisions can only be approved at a locked current revision; legacy variants (none) approve as before.
  // Lock every variant row of the job, in id order, before checking: the UPDATE below touches them all, so a consistent order can't deadlock
  // two concurrent approves, and a revision POST (FOR SHARE on its variant) can't slip a new pending child between this check and the approve.
  const rows = await udb.select({ id: variants.id, variantNo: variants.variantNo }).from(variants).where(eq(variants.jobId, jobId)).orderBy(variants.id).for('update');
  const target = rows.find((r) => r.variantNo === n);
  const cur = target ? await currentRevision(udb, target.id) : undefined;
  if (cur?.locked === false) return 'unlocked';
  // An edited revision (has a parent) delivers its export; revision 0 delivers variants.renderAssetId as before.
  if (cur?.parentId && !cur.renderAssetId) return 'unexported';
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
