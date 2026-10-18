import {
  boolean,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
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
export const membershipRole = pgEnum('membership_role', ['owner', 'member']);
export const waitlistStatus = pgEnum('waitlist_status', ['new', 'invited', 'joined']);
export const libraryKind = pgEnum('library_kind', ['product_view', 'location', 'prop', 'brand_kit', 'voice']);
export const libraryStatus = pgEnum('library_status', ['active', 'superseded']);

/**
 * `id` equals the Supabase `auth.users.id` of the same person. There is no FK: `auth` is
 * Supabase's schema (absent on PGlite), so provisioning writes the id explicitly. The default only serves local seeds.
 */
export const users = pgTable('users', {
  id: id(),
  email: text().notNull().unique(),
  isAdmin: boolean().notNull().default(false),
  createdAt: createdAt(),
});

// --- tenancy -----------------------------------------------------------------
// Every tenant row carries org_id: it is what RLS filters on, so it is indexed.
// Parent references are composite, (parent_id, org_id) -> parent (id, org_id): a row can never point into another org.

export const orgs = pgTable('orgs', {
  id: id(),
  name: text().notNull(),
  createdAt: createdAt(),
});

export const memberships = pgTable(
  'memberships',
  {
    orgId: uuid().notNull().references(() => orgs.id),
    userId: uuid().notNull().references(() => users.id),
    role: membershipRole().notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.userId] }), index().on(t.userId)],
);

/** Public sign-up queue; not tenant data (admin-only under RLS). */
export const waitlist = pgTable('waitlist', {
  id: id(),
  name: text().notNull(),
  email: text().notNull().unique(),
  brand: text().notNull(),
  website: text(),
  category: text().notNull(),
  country: text().notNull(),
  note: text(),
  status: waitlistStatus().notNull().default('new'),
  createdAt: createdAt(),
  invitedAt: timestamp({ withTimezone: true }),
});

export const projects = pgTable(
  'projects',
  {
    id: id(),
    orgId: uuid().notNull().references(() => orgs.id),
    userId: uuid().notNull().references(() => users.id),
    name: text().notNull(),
    brandKit: jsonb().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [unique().on(t.id, t.orgId), unique().on(t.orgId, t.name), index().on(t.orgId)],
);

export const assets = pgTable(
  'assets',
  {
    id: id(),
    orgId: uuid().notNull().references(() => orgs.id),
    projectId: uuid().notNull(),
    kind: text().notNull(), // upload | cutout | plate | broll | voice | render
    storageKey: text().notNull(),
    mime: text().notNull(),
    width: integer(),
    height: integer(),
    durationSec: doublePrecision(),
    bytes: integer().notNull(),
    sha256: text().notNull(),
    sourceUrl: text(),
    /** Plate assets: { plate: PlateAnalysis, lumaGrid: number[][], depthKey: string }. Null until (or unless) analysed. */
    // Explicitly named: assetsForInsert (assets-insert.ts) shares this table name without it, and drizzle's casing cache is per table name.
    analysis: jsonb('analysis'),
    createdAt: createdAt(),
  },
  // (org_id, sha256) doubles as the org_id index.
  (t) => [
    unique().on(t.orgId, t.sha256),
    unique().on(t.id, t.orgId),
    foreignKey({ columns: [t.projectId, t.orgId], foreignColumns: [projects.id, projects.orgId] }),
  ],
);

export const products = pgTable(
  'products',
  {
    id: id(),
    orgId: uuid().notNull().references(() => orgs.id),
    projectId: uuid().notNull(),
    name: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [unique().on(t.id, t.orgId), index().on(t.orgId), foreignKey({ columns: [t.projectId, t.orgId], foreignColumns: [projects.id, projects.orgId] })],
);

/**
 * Library entries (creative §4.1). `tag` is the base tag without a version; a new state is a new row (version + 1).
 * (org_id, tag, version) doubles as the org_id index. Written by the pipeline on the owner connection; members read only.
 */
export const libraryAssets = pgTable(
  'library_assets',
  {
    id: id(),
    orgId: uuid().notNull().references(() => orgs.id),
    projectId: uuid().notNull(),
    productId: uuid(),
    tag: text().notNull(),
    version: integer().notNull(),
    kind: libraryKind().notNull(),
    descriptor: text().notNull(),
    storageKey: text(),
    meta: jsonb().notNull().default({}),
    status: libraryStatus().notNull().default('active'),
    heroEligible: boolean().notNull().default(false),
    gate: jsonb(),
    createdAt: createdAt(),
  },
  (t) => [
    unique().on(t.orgId, t.tag, t.version),
    foreignKey({ columns: [t.projectId, t.orgId], foreignColumns: [projects.id, projects.orgId] }),
    // MATCH SIMPLE: a NULL product_id is not checked.
    foreignKey({ columns: [t.productId, t.orgId], foreignColumns: [products.id, products.orgId] }),
  ],
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
  orgId: uuid().notNull().references(() => orgs.id),
  projectId: uuid().notNull(),
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
}, (t) => [
  unique().on(t.id, t.orgId),
  index().on(t.orgId),
  foreignKey({ columns: [t.projectId, t.orgId], foreignColumns: [projects.id, projects.orgId] }),
]);

/** Slugs, not foreign keys — a retired registry row can never orphan a historical variant. */
export const variants = pgTable(
  'variants',
  {
    id: id(),
    orgId: uuid().notNull().references(() => orgs.id),
    jobId: uuid().notNull(),
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
    renderAssetId: uuid(),
    costUsd: doublePrecision().notNull().default(0),
    error: jsonb(),
    createdAt: createdAt(),
  },
  (t) => [
    unique().on(t.jobId, t.variantNo),
    unique().on(t.id, t.orgId),
    index().on(t.orgId),
    foreignKey({ columns: [t.jobId, t.orgId], foreignColumns: [jobs.id, jobs.orgId] }),
    // MATCH SIMPLE: a NULL render_asset_id is not checked.
    foreignKey({ columns: [t.renderAssetId, t.orgId], foreignColumns: [assets.id, assets.orgId] }),
  ],
);

export const providerCalls = pgTable('provider_calls', {
  id: id(),
  orgId: uuid().notNull().references(() => orgs.id),
  jobId: uuid(),
  variantId: uuid(),
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
}, (t) => [
  index().on(t.orgId),
  foreignKey({ columns: [t.jobId, t.orgId], foreignColumns: [jobs.id, jobs.orgId] }),
  foreignKey({ columns: [t.variantId, t.orgId], foreignColumns: [variants.id, variants.orgId] }),
]);
