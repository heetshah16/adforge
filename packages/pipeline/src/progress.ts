import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '@adforge/db/client';
import { jobs } from '@adforge/db/schema';

type Status = 'running' | 'done' | 'failed' | 'skipped';

export async function markProgress(db: Db, jobId: string, stage: string, status: Status, detail?: string): Promise<void> {
  const entry = { stage, status, at: new Date().toISOString(), ...(detail ? { detail } : {}) };
  await db
    .update(jobs)
    .set({ progress: sql`${jobs.progress} || ${JSON.stringify([entry])}::jsonb` })
    .where(eq(jobs.id, jobId));
}

export async function setJobStatus(db: Db, jobId: string, patch: Partial<typeof jobs.$inferInsert>): Promise<void> {
  await db.update(jobs).set(patch).where(eq(jobs.id, jobId));
}

/** Fail a dead run's job, but only while it is still queued/running: a completed or already-failed job is never overwritten. */
export async function failJob(db: Db, jobId: string, reason: string, stage = 'inngest'): Promise<boolean> {
  const rows = await db
    .update(jobs)
    .set({ status: 'failed', completedAt: new Date(), error: { stage, reason } })
    .where(and(eq(jobs.id, jobId), inArray(jobs.status, ['running', 'queued'])))
    .returning({ id: jobs.id });
  if (rows.length) await markProgress(db, jobId, stage, 'failed', reason);
  return rows.length > 0;
}
