import { describe, expect, it } from 'vitest';
import { openDb } from '../src/client';
import { pgOptions, STATEMENT_TIMEOUT_MS } from '../src/client';
import { withUser } from '../src/with-user';

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
      const rows = await withUser(db, '00000000-0000-0000-0000-000000000001', (u) => u.execute<{ statement_timeout: string }>('show statement_timeout' as never));
      const v = ((rows as unknown as { rows?: unknown[] }).rows ?? (rows as unknown as unknown[]))[0] as { statement_timeout: string };
      expect(v.statement_timeout).toBe(`${STATEMENT_TIMEOUT_MS / 1000}s`);
    } finally {
      await close();
    }
  });
});
