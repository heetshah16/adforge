import { openPostgres, type Db } from '@adforge/db/client';
import { serverEnv } from './env';

// Cached on globalThis so dev hot reload doesn't open a new pool per module reload. Lazy: `next build` never opens a DB.
const g = globalThis as { __adforgeDb?: Promise<Db> };

/** Owner connection (bypasses RLS). Use only from *-owner.ts modules; everything else goes through withUser. */
export function getDb(): Promise<Db> {
  g.__adforgeDb ??= openPostgres(serverEnv().DATABASE_URL, { migrate: false }).then((r) => r.db);
  return g.__adforgeDb;
}
