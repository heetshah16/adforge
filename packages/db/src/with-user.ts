import { sql } from 'drizzle-orm';
import type { Db } from './client';

/** A handle whose queries run as `authenticated` under RLS, as `userId`. Only withUser makes one. */
export type UserDb = Db & { readonly __rls: unique symbol };

/**
 * Runs `fn` in a transaction as role `authenticated` with Supabase-shaped JWT claims, so RLS and `auth.uid()`
 * see `userId`. Both settings are transaction-local: nothing outlives the transaction, commit or rollback.
 */
export function withUser<T>(db: Db, userId: string, fn: (udb: UserDb) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`set local role authenticated`);
    await tx.execute(sql`select set_config('request.jwt.claims', ${JSON.stringify({ sub: userId, role: 'authenticated' })}, true)`);
    return fn(tx as unknown as UserDb);
  });
}
