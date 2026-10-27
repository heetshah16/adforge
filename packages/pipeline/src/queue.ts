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

async function percentiles(db: Db, language: string | null, broll: string | null, recentOnly: boolean): Promise<{ p50: number; p90: number } | null> {
  const where = recentOnly
    ? and(eq(jobs.status, 'completed'), sql`${jobs.completedAt} > now() - interval '30 days'`, sql`(${jobs.inputSpec}->>'language') is not distinct from ${language}`, sql`(${jobs.inputSpec}->>'broll') is not distinct from ${broll}`)
    : eq(jobs.status, 'completed');
  const [r] = await db.select({
    p50: sql<number | null>`percentile_cont(0.5) within group (order by ${durationSec})::float8`,
    p90: sql<number | null>`percentile_cont(0.9) within group (order by ${durationSec})::float8`,
  }).from(jobs).where(where);
  return r?.p50 != null && r?.p90 != null ? { p50: r.p50, p90: r.p90 } : null;
}

/**
 * Queue position and ETA for a queued or running job, across all orgs. Null when the job is
 * neither queued nor running. `position` is 1 + the queued/running jobs created before this one;
 * `etaRange` is `[ahead × p50 + remaining, ahead × p90 + remaining]` seconds (`remaining` is the
 * running job's own time left, 0 for a queued job), or `'paused'` when no worker is live.
 * Every time comparison uses the SQL clock — the web and the GPU machine have different clocks.
 */
export async function queueStatus(db: Db, jobId: string, _now?: Date): Promise<QueueStatus> {
  const [job] = await db.select({ status: jobs.status, createdAt: jobs.createdAt, dispatchedAt: jobs.dispatchedAt, inputSpec: jobs.inputSpec }).from(jobs).where(eq(jobs.id, jobId));
  if (!job || (job.status !== 'queued' && job.status !== 'running')) return null;
  const [pos] = await db.select({ n: sql<number>`count(*)::int` }).from(jobs)
    .where(and(inArray(jobs.status, ['queued', 'running']), sql`${jobs.createdAt} < ${job.createdAt}`));
  const ahead = pos?.n ?? 0;
  if (!(await workerOnline(db))) return { position: ahead + 1, etaRange: 'paused' };
  const spec = (job.inputSpec ?? {}) as { language?: unknown; broll?: unknown };
  const language = typeof spec.language === 'string' ? spec.language : null;
  const broll = typeof spec.broll === 'boolean' ? String(spec.broll) : null;
  const pct = (await percentiles(db, language, broll, true))
    ?? (await percentiles(db, language, broll, false))
    ?? { p50: PIPELINE.jobs.defaultDurationSec, p90: PIPELINE.jobs.defaultDurationSec };
  let remaining = 0;
  if (job.status === 'running') {
    if (job.dispatchedAt) {
      const [e] = await db.select({ s: sql<number>`extract(epoch from (now() - ${job.dispatchedAt}))::float8` }).from(jobs).where(eq(jobs.id, jobId));
      remaining = Math.max(0, pct.p50 - (e?.s ?? 0));
    } else {
      remaining = pct.p50;
    }
  }
  return { position: ahead + 1, etaRange: [Math.max(0, Math.round(ahead * pct.p50 + remaining)), Math.max(0, Math.round(ahead * pct.p90 + remaining))] };
}
