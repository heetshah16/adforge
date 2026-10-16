import { eq } from 'drizzle-orm';
import { PIPELINE } from '@adforge/core/config/pipeline';
import { jobs } from '@adforge/db/schema';
import type { PipelineDeps } from './types';

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
  const stillRunning = running.length - stalled.length;
  if (stillRunning > 0) return { freed: false, stalled };
  await deps.comfy.free().catch(() => {});
  await deps.voice.unload().catch(() => {});
  return { freed: true, stalled };
}
