import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/client';
import { diffColumns, listColumns, type ColumnRow } from '../src/schema-diff';

const col = (table: string, column: string, type = 'text', nullable = false): ColumnRow => ({ table, column, type, nullable });

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});

describe('diffColumns', () => {
  it('returns no lines for identical lists', () => {
    const a = [col('jobs', 'id'), col('jobs', 'status')];
    expect(diffColumns(a, [...a])).toEqual([]);
  });

  it('reports a type mismatch as one line naming table.column and both types', () => {
    const a = [col('jobs', 'status', 'text')];
    const b = [col('jobs', 'status', 'character varying')];
    const lines = diffColumns(a, b);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('jobs.status');
    expect(lines[0]).toContain('text');
    expect(lines[0]).toContain('character varying');
  });

  it('reports a column present on one side only as a "missing in" line', () => {
    const a = [col('variants', 'error')];
    expect(diffColumns(a, [])).toEqual(['variants.error: missing in postgres']);
    expect(diffColumns([], a)).toEqual(['variants.error: missing in pglite']);
  });
});

describe('listColumns', () => {
  it('lists the jobs table columns on in-memory PGlite, including shortlist', async () => {
    const { db, close } = await openDb();
    closers.push(close);
    const rows = await listColumns(db);
    const jobCols = rows.filter((r) => r.table === 'jobs').map((r) => r.column);
    expect(jobCols).toContain('shortlist');
    expect(rows.find((r) => r.table === 'jobs' && r.column === 'shortlist')?.type).toBe('jsonb');
  });

  it('returns rows sorted by table then column', async () => {
    const { db, close } = await openDb();
    closers.push(close);
    const rows = await listColumns(db);
    const keys = rows.map((r) => `${r.table}\u0000${r.column}`);
    expect([...keys].sort()).toEqual(keys);
  });
});
