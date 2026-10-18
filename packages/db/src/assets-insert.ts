import { doublePrecision, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * `assets` without `analysis`, for INSERTs. Drizzle names every column in an INSERT (as DEFAULT when unset), and a member's INSERT
 * grant (migration 0015) excludes the worker-owned `analysis`, so member-path inserts must go through this table. Keep the columns in
 * step with `assets` in schema.ts (the privilege-matrix test fails if they drift); it is not defined there because drizzle-kit would
 * read a second `assets` as a duplicate table.
 */
export const assetsForInsert = pgTable('assets', {
  id: uuid().primaryKey().defaultRandom(),
  orgId: uuid().notNull(),
  projectId: uuid().notNull(),
  kind: text().notNull(),
  storageKey: text().notNull(),
  mime: text().notNull(),
  width: integer(),
  height: integer(),
  durationSec: doublePrecision(),
  bytes: integer().notNull(),
  sha256: text().notNull(),
  sourceUrl: text(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});
