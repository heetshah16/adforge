import { and, eq, sql, type SQL } from 'drizzle-orm';
import { PIPELINE } from '@adforge/core/config/pipeline';
import type { Db } from '@adforge/db/client';
import { jobs, variantRevisions, workers } from '@adforge/db/schema';
import { freshOnline } from './dispatch';
import type { PipelineDeps } from './types';

// Light module (db + core only): runJanitor runs in the web's adforge-web app. freeIdleGpu takes PipelineDeps as a type only.

/** variant-edit's start (queue) and finish timeouts. A revision still pending past both, counted from its creation, has no live run. */
export const EDIT_START_MIN = 120;
export const EDIT_FINISH_MIN = 120;

/**
 * Liveness sweep (every 5 min, adforge-web), on the SQL clock. A running job is failed only while a worker is live, and only
 * when it has been silent past staleAfterMin counted from the later of its last progress and the start of the worker's
 * current online stretch (workers.online_since): offline its step is paused, and right after a reconnect it gets a fresh
 * window to resume. A pending revision past the edit timeout can no longer be running, so it is failed either way.
 */
export async function runJanitor(db: Db): Promise<{ stalled: string[] }> {
  const stalled: string[] = [];
  const ms = (x: SQL) => sql<number | null>`(extract(epoch from ${x}) * 1000)::float8`;
  const [w] = await db.select({
    now: ms(sql`now()`),
    online: sql<boolean>`coalesce(bool_or(${freshOnline}), false)`,
    since: ms(sql`min(${workers.onlineSince}) filter (where ${freshOnline})`),
  }).from(workers);
  if (w?.online) {
    const cutoff = w.now! - PIPELINE.jobs.staleAfterMin * 60_000;
    for (const j of await db.select({ id: jobs.id, progress: jobs.progress, createdAt: jobs.createdAt }).from(jobs).where(eq(jobs.status, 'running'))) {
      // A malformed progress timestamp falls back to created_at instead of aborting the sweep.
      const at = Date.parse(j.progress.at(-1)?.at ?? '');
      const last = Number.isNaN(at) ? j.createdAt.getTime() : at;
      if (Math.max(last, w.since ?? -Infinity) >= cutoff) continue;
      const [hit] = await db.update(jobs).set({ status: 'failed', completedAt: sql`now()`, error: { stage: 'janitor', reason: `stalled: no progress since ${new Date(last).toISOString()}` } })
        .where(and(eq(jobs.id, j.id), eq(jobs.status, 'running'))).returning({ id: jobs.id });
      if (hit) stalled.push(hit.id);
    }
  }
  await db.update(variantRevisions).set({ status: 'failed', error: { message: 'edit timed out' } })
    .where(and(eq(variantRevisions.status, 'pending'), sql`${variantRevisions.createdAt} < now() - ${EDIT_START_MIN + EDIT_FINISH_MIN}::int * interval '1 minute'`));
  return { stalled };
}

/** adforge-gpu's gpu-idle cron: free ComfyUI and voice when no job is running and no edit is pending. */
export async function freeIdleGpu(deps: PipelineDeps): Promise<boolean> {
  const [run] = await deps.db.select({ id: jobs.id }).from(jobs).where(eq(jobs.status, 'running')).limit(1);
  const [edit] = await deps.db.select({ id: variantRevisions.id }).from(variantRevisions).where(eq(variantRevisions.status, 'pending')).limit(1);
  if (run || edit) return false;
  await deps.comfy.free().catch(() => {});
  await deps.voice.unload().catch(() => {});
  return true;
}
