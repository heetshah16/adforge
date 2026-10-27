import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { PIPELINE } from '@adforge/core/config/pipeline';
import type { Db } from '@adforge/db/client';
import { jobs, workers } from '@adforge/db/schema';

// Light module (db + core only): the web app's adforge-web Inngest app imports it. Never import GPU/LLM code here.

export const DISPATCH_NUDGE = 'adforge/dispatch.nudge';
/** Heavy-lane priority carried on events and invoke payloads: interactive work (edit, export, ingest) runs ahead of queued jobs. */
export type Priority = 'job' | 'interactive';
export type JobEvent = { name: 'adforge/job.requested'; data: { jobId: string; priority: 'job' }; id: string };
export const OFFLINE_ERROR = `GPU offline for ${PIPELINE.jobs.offlineMaxHours} h`;
const CLAIM_LIMIT = 10;

const onlineLastSeen = sql`max(${workers.lastSeen}) filter (where ${workers.status} = 'online')`;

/** Newest heartbeat from a worker that is still 'online'; null if none. A clean stop (status offline) therefore never counts. */
export async function lastSeenOnline(db: Db): Promise<Date | null> {
  const [r] = await db.select({ t: sql<string | null>`${onlineLastSeen}` }).from(workers);
  return r?.t ? new Date(r.t) : null;
}

/** lastSeenOnline within heartbeatFreshSec, compared on the SQL clock: the worker's and Vercel's clocks never meet. */
export async function workerOnline(db: Db): Promise<boolean> {
  const [r] = await db.select({ ok: sql<boolean>`coalesce(${onlineLastSeen} > now() - ${PIPELINE.jobs.heartbeatFreshSec}::int * interval '1 second', false)` }).from(workers);
  return r?.ok === true;
}

/**
 * The only sender of job.requested. Online: claim up to 10 oldest queued, undispatched jobs under FOR UPDATE SKIP LOCKED
 * (overlapping runs never claim the same row) and send each once, event id `job:<id>` (Inngest dedupes a resend). Offline:
 * send nothing; fail undispatched jobs queued longer than offlineMaxHours, guarded by status so it happens once.
 */
export async function runDispatcher(db: Db, send: (e: JobEvent) => Promise<unknown>): Promise<{ online: boolean; sent: string[]; failed: string[] }> {
  if (!(await workerOnline(db))) {
    const failed = await db.update(jobs)
      .set({ status: 'failed', completedAt: sql`now()`, error: { message: OFFLINE_ERROR } })
      .where(and(eq(jobs.status, 'queued'), isNull(jobs.dispatchedAt), sql`${jobs.createdAt} < now() - ${PIPELINE.jobs.offlineMaxHours}::int * interval '1 hour'`))
      .returning({ id: jobs.id });
    return { online: false, sent: [], failed: failed.map((r) => r.id) };
  }
  const oldest = db.select({ id: jobs.id }).from(jobs)
    .where(and(eq(jobs.status, 'queued'), isNull(jobs.dispatchedAt)))
    .orderBy(jobs.createdAt).limit(CLAIM_LIMIT).for('update', { skipLocked: true });
  // = any(array(subquery)), not IN (subquery): the array is an InitPlan run once. A plain IN can be rescanned per outer row,
  // and each rescan's FOR UPDATE skips the rows this UPDATE already changed, so LIMIT 10 claimed every queued job.
  const claimed = await db.update(jobs).set({ dispatchedAt: sql`now()` })
    .where(and(sql`${jobs.id} = any(array(${oldest}))`, isNull(jobs.dispatchedAt)))
    .returning({ id: jobs.id, createdAt: jobs.createdAt });
  const ids = claimed.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).map((r) => r.id);
  for (const [i, jobId] of ids.entries()) {
    try {
      await send({ name: 'adforge/job.requested', data: { jobId, priority: 'job' }, id: `job:${jobId}` });
    } catch (e) {
      // Un-claim this one and the rest so the retry (or the next minute) sends them. A send that did land is deduped by its id.
      await db.update(jobs).set({ dispatchedAt: null }).where(inArray(jobs.id, ids.slice(i)));
      throw e;
    }
  }
  return { online: true, sent: ids, failed: [] };
}
