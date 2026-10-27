import { is, sql } from 'drizzle-orm';
import { PgTransaction } from 'drizzle-orm/pg-core';
import { STATEMENT_TIMEOUT_MS, type Db } from './client';

/** A handle whose queries run as `authenticated` under RLS, as `userId`. Only withUser makes one. */
export type UserDb = Db & { readonly __rls: unique symbol };

/**
 * Runs `fn` in a transaction as role `authenticated` with Supabase-shaped JWT claims, so RLS and `auth.uid()`
 * see `userId`. Both settings are transaction-local: nothing outlives the transaction, commit or rollback.
 *
 * `db` must be a top-level handle. Inside a transaction (a UserDb is one) drizzle would open a savepoint, and
 * SET LOCAL survives the savepoint's release: the rest of the outer transaction would run as `userId`.
 * Refused by type (`__rls`, `rollback`) and at runtime.
 */
export function withUser<T>(
  db: Db & { readonly __rls?: never; readonly rollback?: never },
  userId: string,
  fn: (udb: UserDb) => Promise<T>,
): Promise<T> {
  if (is(db, PgTransaction)) return Promise.reject(new Error('withUser must not be nested in a transaction'));
  return db.transaction(async (tx) => {
    await tx.execute(sql`set local role authenticated`);
    // Transaction-scoped: the only statement_timeout the transaction pooler (:6543) honours.
    await tx.execute(sql`select set_config('statement_timeout', ${String(STATEMENT_TIMEOUT_MS)}, true)`);
    // auth.uid() reads claim.sub first, so it is set too: a stale session-level value must not win.
    await tx.execute(sql`select set_config('request.jwt.claim.sub', ${userId}, true),
      set_config('request.jwt.claims', ${JSON.stringify({ sub: userId, role: 'authenticated' })}, true)`);
    return fn(tx as unknown as UserDb);
  });
}
