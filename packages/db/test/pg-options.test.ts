import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { openDb, pgOptions } from '../src/client';
import { STATEMENT_TIMEOUT_MS, withUser } from '../src/with-user';

function rows<T>(r: unknown): T[] {
  return (Array.isArray(r) ? r : (r as { rows: T[] }).rows) as T[];
}

describe('pgOptions', () => {
  it('is pooler-safe: no prepared statements, and no startup params (Supavisor :6543 ignores them)', () => {
    const o = pgOptions({});
    expect(o.prepare).toBe(false);
    expect(o).not.toHaveProperty('connection');
  });
});

describe('withUser statement timeout', () => {
  it('sets a transaction-local statement_timeout', async () => {
    const { db, close } = await openDb();
    try {
      const [v] = await withUser(db, '00000000-0000-0000-0000-000000000001', async (u) =>
        rows<{ t: string }>(await u.execute(sql`select current_setting('statement_timeout') as t`)));
      expect(v!.t).toBe(`${STATEMENT_TIMEOUT_MS / 1000}s`);
    } finally {
      await close();
    }
  });
});
