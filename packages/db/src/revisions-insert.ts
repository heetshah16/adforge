import { boolean, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';

/**
 * `variant_revisions` restricted to the columns a member may INSERT (migration 0017), like assets-insert.ts: drizzle names every column of
 * the table it is given, so member-path inserts go through this one. Not in schema.ts (drizzle-kit would read a duplicate table). The
 * RLS policy forces status 'pending' and locked false on these rows.
 */
export const revisionsForInsert = pgTable('variant_revisions', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull(),
  variantId: uuid('variant_id').notNull(),
  parentId: uuid('parent_id'),
  ops: jsonb('ops').notNull(),
  beats: jsonb('beats').notNull(),
  status: text('status').notNull(),
  locked: boolean('locked').notNull(),
});
