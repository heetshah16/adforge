import { failJob } from '@adforge/pipeline/progress';
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
