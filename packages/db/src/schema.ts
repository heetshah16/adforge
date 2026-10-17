import {
  boolean,
  doublePrecision,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

const id = () => uuid().primaryKey().defaultRandom();
const createdAt = () => timestamp({ withTimezone: true }).notNull().defaultNow();

export const vocabKind = pgEnum('vocab_kind', ['archetype', 'format', 'hook']);
export const vocabStatus = pgEnum('vocab_status', ['proposed', 'experimental', 'active', 'retired']);
export const jobStatus = pgEnum('job_status', ['queued', 'running', 'completed', 'failed']);
export const variantStatus = pgEnum('variant_status', ['pending', 'running', 'completed', 'failed', 'approved']);
export const callStatus = pgEnum('call_status', ['pending', 'done', 'failed']);

export const users = pgTable('users', {
  id: id(),
  email: text().notNull().unique(),
  createdAt: createdAt(),
});

export const projects = pgTable('projects', {
  id: id(),
  userId: uuid().notNull().references(() => users.id),
  name: text().notNull(),
  brandKit: jsonb().notNull().default({}),
  createdAt: createdAt(),
});

export const assets = pgTable(
  'assets',
  {
    id: id(),
    projectId: uuid().notNull().references(() => projects.id),
    kind: text().notNull(), // upload | cutout | plate | broll | voice | render
    storageKey: text().notNull(),
    mime: text().notNull(),
    width: integer(),
    height: integer(),
    durationSec: doublePrecision(),
    bytes: integer().notNull(),
    sha256: text().notNull(),
    sourceUrl: text(),
    createdAt: createdAt(),
  },
  (t) => [unique().on(t.projectId, t.sha256)],
);

// --- the adaptive vocabulary (architecture §5.1) ----------------------------
// Slugs are the attribution key: never renamed, never reused, never deleted.

export const vocabFamilies = pgTable('vocab_families', {
  id: id(),
  kind: vocabKind().notNull(),
  slug: text().notNull().unique(),
  name: text().notNull(),
});

export const archetypes = pgTable('archetypes', {
  id: id(),
  slug: text().notNull().unique(),
  familyId: uuid().references(() => vocabFamilies.id),
  name: text().notNull(),
  buyingDriver: text().notNull(),
  definition: text().notNull(),
  examples: jsonb().$type<string[]>().notNull().default([]),
  status: vocabStatus().notNull().default('proposed'),
  createdAt: createdAt(),
  retiredAt: timestamp({ withTimezone: true }),
});

/** fitsArchetypes = [] means "fits any archetype". */
export const formats = pgTable('formats', {
  id: id(),
  slug: text().notNull().unique(),
  familyId: uuid().notNull().references(() => vocabFamilies.id),
  name: text().notNull(),
  beats: jsonb().$type<string[]>().notNull(),
  fitsArchetypes: text().array().notNull().default([]),
  definition: text().notNull(),
  status: vocabStatus().notNull().default('proposed'),
  createdAt: createdAt(),
  retiredAt: timestamp({ withTimezone: true }),
});

export const hookArchetypes = pgTable('hook_archetypes', {
  id: id(),
  slug: text().notNull().unique(),
  familyId: uuid().notNull().references(() => vocabFamilies.id),
  name: text().notNull(),
  shape: text().notNull(),
  skeleton: text().notNull(),
  constraints: jsonb().$type<string[]>().notNull().default([]),
  fitsArchetypes: text().array().notNull().default([]),
  status: vocabStatus().notNull().default('proposed'),
  createdAt: createdAt(),
  retiredAt: timestamp({ withTimezone: true }),
});

// --- jobs --------------------------------------------------------------------

/** One line of the append-only stage log shown in the UI. */
export type ProgressEntry = { stage: string; status: 'running' | 'done' | 'failed' | 'skipped'; at: string; detail?: string };

export const jobs = pgTable('jobs', {
  id: id(),
  projectId: uuid().notNull().references(() => projects.id),
  userId: uuid().notNull().references(() => users.id),
  status: jobStatus().notNull().default('queued'),
  inputSpec: jsonb().notNull(),
  brief: jsonb(),
  shortlist: jsonb(),
  /** Resolved config, treatment params, workflow names, model ids and prompt hashes this job ran with. */
  configSnapshot: jsonb(),
  /** Append-only stage log for the UI. */
  progress: jsonb().$type<ProgressEntry[]>().notNull().default([]),
  costUsd: doublePrecision().notNull().default(0),
  error: jsonb(),
  createdAt: createdAt(),
  completedAt: timestamp({ withTimezone: true }),
});

/** Slugs, not foreign keys — a retired registry row can never orphan a historical variant. */
export const variants = pgTable(
  'variants',
  {
    id: id(),
    jobId: uuid().notNull().references(() => jobs.id),
    variantNo: integer().notNull(),
    formatSlug: text().notNull(),
    hookSlug: text().notNull(),
    archetypeSlug: text().notNull(),
    visualTreatment: text().notNull(),
    strategicBet: text().notNull(),
    isExploratory: boolean().notNull().default(false),
    direction: jsonb(),
    spec: jsonb(),
    status: variantStatus().notNull().default('pending'),
    renderAssetId: uuid().references(() => assets.id),
    costUsd: doublePrecision().notNull().default(0),
    error: jsonb(),
    createdAt: createdAt(),
  },
  (t) => [unique().on(t.jobId, t.variantNo)],
);

export const providerCalls = pgTable('provider_calls', {
  id: id(),
  jobId: uuid().references(() => jobs.id),
  variantId: uuid().references(() => variants.id),
  kind: text().notNull(),
  provider: text().notNull(),
  model: text(),
  requestHash: text().notNull(),
  /** Double-fire guard. */
  idempotencyKey: text().notNull().unique(),
  latencyMs: integer(),
  costUsd: doublePrecision().notNull().default(0),
  status: callStatus().notNull().default('pending'),
  error: jsonb(),
  createdAt: createdAt(),
});
