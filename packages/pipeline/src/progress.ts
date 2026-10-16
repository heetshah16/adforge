import { eq, sql } from 'drizzle-orm';
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
