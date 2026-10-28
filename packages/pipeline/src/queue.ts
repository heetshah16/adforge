import { and, eq, inArray, sql } from 'drizzle-orm';
import { PIPELINE } from '@adforge/core/config/pipeline';
import type { Db } from '@adforge/db/client';
import { jobs } from '@adforge/db/schema';
import { workerOnline } from './dispatch';

// Light module (db + core only): the web app imports it through queue-owner.ts. Never import GPU/LLM code here.

/** Time until this job starts (plus its own remaining work when running), or 'paused' when no worker is live. */
export type QueueEta = [number, number] | 'paused';
/** Null when the job is not queued or running. Carries no ids — safe to merge into the job view. */
export type QueueStatus = { position: number; etaRange: QueueEta } | null;

/** Duration of one completed job in seconds, on the SQL clock. */
const durationSec = sql`extract(epoch from (${jobs.completedAt} - coalesce(${jobs.dispatchedAt}, ${jobs.createdAt})))`;

/** Only jobs that actually took time count toward the percentiles. */
const positiveDuration = sql`${jobs.completedAt} > coalesce(${jobs.dispatchedAt}, ${jobs.createdAt})`;

async function percentiles(db: Db, language: string | null, broll: string | null, recentOnly: boolean): Promise<{ p50: number; p90: number } | null> {
  const where = recentOnly
    ? and(eq(jobs.status, 'completed'), positiveDuration, sql`${jobs.completedAt} > now() - interval '30 days'`, sql`(${jobs.inputSpec}->>'language') is not distinct from ${language}`, sql`(${jobs.inputSpec}->>'broll') is not distinct from ${broll}`)
    : and(eq(jobs.status, 'completed'), positiveDuration);
  const [r] = await db.select({
    p50: sql<number | null>`percentile_cont(0.5) within group (order by ${durationSec})::float8`,
    p90: sql<number | null>`percentile_cont(0.9) within group (order by ${durationSec})::float8`,
  }).from(jobs).where(where);
  return r?.p50 != null && r?.p90 != null ? { p50: r.p50, p90: r.p90 } : null;
}

/**
 * Queue position and ETA for a queued or running job, across all orgs. Null when the job is
 * neither queued nor running. `position` is 1 + the queued/running jobs created before this one.
 * For a queued job, `etaRange` is `[ahead × p50 + rest50, ahead × p90 + rest90]` where `ahead` is
 * the queued jobs before it and `rest` sums `max(0, p − elapsed)` over the running jobs before it
 * (elapsed is 0 when dispatched_at is null). For a running job it is its own
 * `[max(0, p50 − e), max(0, p90 − e)]`, ignoring jobs ahead. `'paused'` when no worker is live.
 * Every time comparison uses the SQL clock — the web and the GPU machine have different clocks —
 * and no JS Date is ever interpolated into SQL (postgres-js rejects Date params, and a Date would
 * truncate microseconds and miscount jobs created in the same millisecond).
 */
export async function queueStatus(db: Db, jobId: string): Promise<QueueStatus> {
  const [job] = await db.select({
    status: jobs.status,
    inputSpec: jobs.inputSpec,
    elapsed: sql<number | null>`extract(epoch from now() - ${jobs.dispatchedAt})::float8`,
  }).from(jobs).where(eq(jobs.id, jobId));
  if (!job || (job.status !== 'queued' && job.status !== 'running')) return null;
  // Jobs created before the target, compared in SQL at full timestamptz precision.
  const before = sql`${jobs.createdAt} < (select ${jobs.createdAt} from ${jobs} where ${jobs.id} = ${jobId})`;
  const [pos] = await db.select({ n: sql<number>`count(*)::int` }).from(jobs)
    .where(and(inArray(jobs.status, ['queued', 'running']), before));
  const position = (pos?.n ?? 0) + 1;
  if (!(await workerOnline(db))) return { position, etaRange: 'paused' };
  const spec = (job.inputSpec ?? {}) as { language?: unknown; broll?: unknown };
  const language = typeof spec.language === 'string' ? spec.language : null;
  const broll = typeof spec.broll === 'boolean' ? String(spec.broll) : null;
  const pct = (await percentiles(db, language, broll, true))
    ?? (await percentiles(db, language, broll, false))
    ?? { p50: PIPELINE.jobs.defaultDurationSec, p90: PIPELINE.jobs.defaultDurationSec };
  if (job.status === 'running') {
    const e = job.elapsed ?? 0;
    return { position, etaRange: [Math.max(0, Math.round(pct.p50 - e)), Math.max(0, Math.round(pct.p90 - e))] };
  }
  const [agg] = await db.select({
    queued: sql<number>`count(*) filter (where ${jobs.status} = 'queued')::int`,
    rest50: sql<number>`coalesce(sum(greatest(0, ${pct.p50} - coalesce(extract(epoch from now() - ${jobs.dispatchedAt})::float8, 0))) filter (where ${jobs.status} = 'running'), 0)::float8`,
    rest90: sql<number>`coalesce(sum(greatest(0, ${pct.p90} - coalesce(extract(epoch from now() - ${jobs.dispatchedAt})::float8, 0))) filter (where ${jobs.status} = 'running'), 0)::float8`,
  }).from(jobs).where(before);
  const ahead = agg?.queued ?? 0;
  return {
    position,
    etaRange: [
      Math.max(0, Math.round(ahead * pct.p50 + (agg?.rest50 ?? 0))),
      Math.max(0, Math.round(ahead * pct.p90 + (agg?.rest90 ?? 0))),
    ],
  };
}
