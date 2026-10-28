import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { PIPELINE } from '@adforge/core/config/pipeline';
import type { Db } from '@adforge/db/client';
import { jobs, workers } from '@adforge/db/schema';

// Light module (db + core only): the web app's adforge-web Inngest app imports it. Never import GPU/LLM code here.

export const DISPATCH_NUDGE = 'adforge/dispatch.nudge';
/** Heavy-lane priority carried on events and invoke payloads: interactive work (edit, export, ingest) runs ahead of queued jobs. */
export type Priority = 'job' | 'interactive';
export type JobEvent = { name: 'adforge/job.requested'; data: { jobId: string; priority: 'job' }; id: string };
export const OFFLINE_ERROR = `GPU offline for ${PIPELINE.jobs.offlineMaxHours} h`;
/** A send that has not settled by then rejects, so a hung Inngest call cannot hold the claim's row locks. */
export const SEND_TIMEOUT_MS = 5_000;
const CLAIM_LIMIT = 10;
/** generate-ads' Inngest concurrency limit; the dispatcher never has more jobs than this in flight. One source for both. */
export const GENERATE_ADS_CONCURRENCY = 2;
/** pg_advisory_xact_lock key that serializes dispatchers over one DB (any fixed bigint; transaction-scoped, so pooler-safe). */
const DISPATCH_LOCK_KEY = 4_120_250_001;

const onlineLastSeen = sql`max(${workers.lastSeen}) filter (where ${workers.status} = 'online')`;
/** A workers row that is online with a heartbeat younger than heartbeatFreshSec, on the SQL clock. */
export const freshOnline = sql`(${workers.status} = 'online' and ${workers.lastSeen} > now() - ${PIPELINE.jobs.heartbeatFreshSec}::int * interval '1 second')`;

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

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<never>((_, reject) => { t = setTimeout(() => reject(new Error(`send timed out after ${ms} ms`)), ms); })]);
  } finally {
    clearTimeout(t);
  }
}

/**
 * The only sender of job.requested.
 * Online: in ONE transaction, holding a transaction-scoped advisory lock (dispatchers over one DB take turns), count the jobs
 * in flight (dispatched, still queued or running) and claim min(10, GENERATE_ADS_CONCURRENCY - inFlight) oldest queued,
 * undispatched jobs under FOR UPDATE SKIP LOCKED (never the same row twice). No capacity: no claim, no send. Send each with
 * event id `job:<id>`, and commit after the last send. A failed or timed-out send
 * (or a crash) rolls the claim back, so no job is ever left claimed but unsent; a send that landed before the rollback is
 * re-sent next run and dropped by Inngest's 24 h event-id dedupe.
 * Offline: send nothing; fail every queued job older than offlineMaxHours, dispatched or not (a dispatched job whose run never
 * started would otherwise wait forever), guarded by status so it happens once. Same shape as failJob.
 */
export async function runDispatcher(
  db: Db, send: (e: JobEvent) => Promise<unknown>, opts: { sendTimeoutMs?: number } = {},
): Promise<{ online: boolean; sent: string[]; failed: string[] }> {
  if (!(await workerOnline(db))) {
    const entry = { stage: 'dispatch', status: 'failed', at: new Date().toISOString(), detail: OFFLINE_ERROR };
    const failed = await db.update(jobs)
      .set({ status: 'failed', completedAt: sql`now()`, error: { stage: 'dispatch', reason: OFFLINE_ERROR }, progress: sql`${jobs.progress} || ${JSON.stringify([entry])}::jsonb` })
      .where(and(eq(jobs.status, 'queued'), sql`${jobs.createdAt} < now() - ${PIPELINE.jobs.offlineMaxHours}::int * interval '1 hour'`))
      .returning({ id: jobs.id });
    return { online: false, sent: [], failed: failed.map((r) => r.id) };
  }
  const sent = await db.transaction(async (tx) => {
    // Server-side bound for a frozen (not killed) process: the JS send timeout only runs while the process does. Transaction-scoped, so pooler-safe.
    await tx.execute(sql`set local idle_in_transaction_session_timeout = '60s'`);
    await tx.execute(sql`select pg_advisory_xact_lock(${DISPATCH_LOCK_KEY}::bigint)`);
    const [f] = await tx.select({ n: sql<number>`count(*)::int` }).from(jobs)
      .where(and(isNotNull(jobs.dispatchedAt), inArray(jobs.status, ['queued', 'running'])));
    const capacity = Math.min(CLAIM_LIMIT, Math.max(0, GENERATE_ADS_CONCURRENCY - Number(f?.n ?? 0)));
    if (capacity === 0) return [];
    const oldest = tx.select({ id: jobs.id }).from(jobs)
      .where(and(eq(jobs.status, 'queued'), isNull(jobs.dispatchedAt)))
      .orderBy(jobs.createdAt).limit(capacity).for('update', { skipLocked: true });
    // = any(array(subquery)), not IN (subquery): the array is an InitPlan run once. A plain IN can be rescanned per outer row,
    // and each rescan's FOR UPDATE skips the rows this UPDATE already changed, so the LIMIT claimed every queued job.
    const claimed = await tx.update(jobs).set({ dispatchedAt: sql`now()` })
      .where(and(sql`${jobs.id} = any(array(${oldest}))`, isNull(jobs.dispatchedAt)))
      .returning({ id: jobs.id, createdAt: jobs.createdAt });
    const ids = claimed.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).map((r) => r.id);
    for (const jobId of ids) {
      await withTimeout(send({ name: 'adforge/job.requested', data: { jobId, priority: 'job' }, id: `job:${jobId}` }), opts.sendTimeoutMs ?? SEND_TIMEOUT_MS);
    }
    return ids;
  });
  return { online: true, sent, failed: [] };
}
