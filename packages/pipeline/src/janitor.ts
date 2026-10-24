import { and, eq, lt } from 'drizzle-orm';
import { PIPELINE } from '@adforge/core/config/pipeline';
import { jobs, variantRevisions } from '@adforge/db/schema';
import type { PipelineDeps } from './types';

/** The variant-edit function's finish timeout; the janitor fails a revision still pending past it (its run is dead). */
export const EDIT_FINISH_MIN = 120;

/** Liveness sweep (every 5 min): fail silent jobs, then free ComfyUI + voice if no job is running. */
export async function runJanitor(deps: PipelineDeps): Promise<{ freed: boolean; stalled: string[] }> {
  const cutoff = Date.now() - PIPELINE.jobs.staleAfterMin * 60_000;
  const running = await deps.db.select().from(jobs).where(eq(jobs.status, 'running'));
  const stalled: string[] = [];
  for (const j of running) {
    const last = j.progress.at(-1)?.at ?? j.createdAt.toISOString();
    if (Date.parse(last) < cutoff) {
      await deps.db.update(jobs).set({ status: 'failed', completedAt: new Date(), error: { stage: 'janitor', reason: `stalled: no progress since ${last}` } }).where(eq(jobs.id, j.id));
      stalled.push(j.id);
    }
  }
  // A pending revision past the edit timeout can no longer be running: fail it. Younger ones keep the GPU holders loaded.
  const editCutoff = new Date(Date.now() - EDIT_FINISH_MIN * 60_000);
  await deps.db.update(variantRevisions).set({ status: 'failed', error: { message: 'edit timed out' } })
    .where(and(eq(variantRevisions.status, 'pending'), lt(variantRevisions.createdAt, editCutoff)));
  const pendingEdits = await deps.db.select({ id: variantRevisions.id }).from(variantRevisions).where(eq(variantRevisions.status, 'pending')).limit(1);
  const stillRunning = running.length - stalled.length + pendingEdits.length;
  if (stillRunning > 0) return { freed: false, stalled };
  await deps.comfy.free().catch(() => {});
  await deps.voice.unload().catch(() => {});
  return { freed: true, stalled };
}
