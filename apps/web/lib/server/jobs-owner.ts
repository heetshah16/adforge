import { and, eq } from 'drizzle-orm';
import { variantRevisions } from '@adforge/db/schema';
import { withUser, type UserDb } from '@adforge/db/with-user';
import { getDb } from './db';

/** The only way app code gets a DB handle: the owner pool is used here to open an RLS transaction as `userId`, and goes no further. */
export async function withCurrentUser<T>(userId: string, fn: (udb: UserDb) => Promise<T>): Promise<T> {
  return withUser(await getDb(), userId, fn);
}

/** `authenticated` cannot set a revision's status, so failing one whose edit event could not be queued needs the owner connection: it would otherwise stay pending forever. */
export async function failRevisionOwner(revisionId: string, reason: string): Promise<void> {
  await (await getDb()).update(variantRevisions).set({ status: 'failed', error: { message: reason } }).where(and(eq(variantRevisions.id, revisionId), eq(variantRevisions.status, 'pending')));
}
