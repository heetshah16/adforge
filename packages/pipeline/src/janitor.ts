import { and, eq, sql } from 'drizzle-orm';
import { PIPELINE } from '@adforge/core/config/pipeline';
import type { Db } from '@adforge/db/client';
import { jobs, variantRevisions } from '@adforge/db/schema';
import { workerOnline } from './dispatch';
import type { PipelineDeps } from './types';

// Light module (db + core only): runJanitor runs in the web's adforge-web app. freeIdleGpu takes PipelineDeps as a type only.

/** variant-edit's start (queue) and finish timeouts. A revision still pending past both, counted from its creation, has no live run. */
export const EDIT_START_MIN = 120;
export const EDIT_FINISH_MIN = 120;

/**
 * Liveness sweep (every 5 min, adforge-web), all on the SQL clock. A running job silent past staleAfterMin is failed only
 * while a worker is live: offline, its step is paused (it resumes on reconnect), not dead. A pending revision past the edit
 * timeout can no longer be running, so it is failed either way.
 */
export async function runJanitor(db: Db): Promise<{ stalled: string[] }> {
  const stalled: string[] = [];
  if (await workerOnline(db)) {
    const last = sql<string>`coalesce((${jobs.progress} -> -1 ->> 'at')::timestamptz, ${jobs.createdAt})`;
    const silent = await db.select({ id: jobs.id, last: sql<string>`${last}::text` }).from(jobs)
      .where(and(eq(jobs.status, 'running'), sql`${last} < now() - ${PIPELINE.jobs.staleAfterMin}::int * interval '1 minute'`));
    for (const j of silent) {
      const [hit] = await db.update(jobs).set({ status: 'failed', completedAt: sql`now()`, error: { stage: 'janitor', reason: `stalled: no progress since ${j.last}` } })
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
