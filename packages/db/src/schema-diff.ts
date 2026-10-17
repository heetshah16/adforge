import { sql } from 'drizzle-orm';
import type { Db } from './client';

export type ColumnRow = { table: string; column: string; type: string; nullable: boolean };

/** Public-schema columns, sorted by table then column. Works on both PGlite and postgres-js result shapes. */
export async function listColumns(db: Db): Promise<ColumnRow[]> {
  const r: unknown = await db.execute(sql`
    select table_name, column_name, data_type, is_nullable
    from information_schema.columns
    where table_schema = 'public'
  `);
  // PGlite returns { rows }, postgres-js returns the row array directly.
  const rows = (Array.isArray(r) ? r : (r as { rows: unknown[] }).rows) as Array<{
    table_name: string;
    column_name: string;
    data_type: string;
    is_nullable: string;
  }>;
  return rows
    .map((x) => ({ table: x.table_name, column: x.column_name, type: x.data_type, nullable: x.is_nullable === 'YES' }))
    .sort((p, q) => (p.table === q.table ? (p.column < q.column ? -1 : p.column > q.column ? 1 : 0) : p.table < q.table ? -1 : 1));
}

/** `a` is PGlite, `b` is Postgres. One line per difference. */
export function diffColumns(a: ColumnRow[], b: ColumnRow[]): string[] {
  const key = (r: ColumnRow) => `${r.table}.${r.column}`;
  const bi = new Map(b.map((r) => [key(r), r]));
  const ai = new Map(a.map((r) => [key(r), r]));
  const lines: string[] = [];
  for (const x of a) {
    const y = bi.get(key(x));
    if (!y) {
      lines.push(`${key(x)}: missing in postgres`);
      continue;
    }
    if (x.type !== y.type) lines.push(`${key(x)}: pglite=${x.type} postgres=${y.type}`);
    if (x.nullable !== y.nullable) lines.push(`${key(x)}: pglite nullable=${x.nullable} postgres nullable=${y.nullable}`);
  }
  for (const y of b) if (!ai.has(key(y))) lines.push(`${key(y)}: missing in pglite`);
  return lines;
}
