import { readFileSync } from 'node:fs';
import { getTableColumns } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { assetsForInsert } from '../src/assets-insert';
import { assets } from '../src/schema';

const sqlNames = (t: typeof assets | typeof assetsForInsert) => Object.fromEntries(Object.entries(getTableColumns(t)).map(([k, c]) => [k, c.name]));

describe('assetsForInsert parity', () => {
  it('has exactly the columns of assets minus analysis, with the same SQL names', () => {
    const { analysis: _a, ...full } = sqlNames(assets);
    expect(sqlNames(assetsForInsert)).toEqual(full);
    expect(Object.values(sqlNames(assets)).every((n) => typeof n === 'string' && n.length > 0)).toBe(true);
  });

  it('migration 0015 grants INSERT on exactly those columns', () => {
    const dir = new URL('../drizzle/', import.meta.url);
    const file = readFileSync(new URL('0015_assets_insert_columns.sql', dir), 'utf8');
    const m = /GRANT INSERT \(([^)]*)\) ON assets TO authenticated/.exec(file);
    expect(m).not.toBeNull();
    const granted = m![1]!.split(',').map((c) => c.trim()).sort();
    expect(granted).toEqual(Object.values(sqlNames(assetsForInsert)).sort());
    expect(granted).not.toContain('analysis');
  });
});
