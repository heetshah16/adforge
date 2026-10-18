import { doublePrecision, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * `assets` without `analysis`, for INSERTs. Drizzle names every column in an INSERT (as DEFAULT when unset), and a member's INSERT
 * grant (migration 0015) excludes the worker-owned `analysis`, so member-path inserts must go through this table. Every column is named
 * explicitly here and in `assets` (drizzle's casing cache is keyed by table name, so a name left to casing would resolve to undefined
 * in one table). assets-insert.test.ts fails if this table's columns or SQL names drift from `assets` minus `analysis`, or from the
 * column list granted in migration 0015. Not defined in schema.ts: drizzle-kit would read a second `assets` as a duplicate table.
 */
export const assetsForInsert = pgTable('assets', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull(),
  projectId: uuid('project_id').notNull(),
  kind: text('kind').notNull(),
  storageKey: text('storage_key').notNull(),
  mime: text('mime').notNull(),
  width: integer('width'),
  height: integer('height'),
  durationSec: doublePrecision('duration_sec'),
  bytes: integer('bytes').notNull(),
  sha256: text('sha256').notNull(),
  sourceUrl: text('source_url'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
