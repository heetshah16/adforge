import { failJob } from '@adforge/pipeline/progress';
import { eq } from 'drizzle-orm';
import { variantRevisions } from '@adforge/db/schema';
import { withUser, type UserDb } from '@adforge/db/with-user';
import { getDb } from './db';

/** The only way app code gets a DB handle: the owner pool is used here to open an RLS transaction as `userId`, and goes no further. */
export async function withCurrentUser<T>(userId: string, fn: (udb: UserDb) => Promise<T>): Promise<T> {
  return withUser(await getDb(), userId, fn);
}

/** `authenticated` cannot update jobs, so marking a job failed when its event could not be queued needs the owner connection. */
export async function failJobOwner(jobId: string, reason: string, stage: string): Promise<void> {
  await failJob(await getDb(), jobId, reason, stage);
}

/** Same for a revision whose edit event could not be queued: it would otherwise stay pending forever. */
export async function failRevisionOwner(revisionId: string, reason: string): Promise<void> {
  await (await getDb()).update(variantRevisions).set({ status: 'failed', error: { stage: 'enqueue', reason } }).where(eq(variantRevisions.id, revisionId));
}
