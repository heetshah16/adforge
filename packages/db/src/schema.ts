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
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

const id = () => uuid().primaryKey().defaultRandom();
const createdAt = () => timestamp({ withTimezone: true }).notNull().defaultNow();

export const vocabKind = pgEnum('vocab_kind', ['archetype', 'format', 'hook']);
export const vocabStatus = pgEnum('vocab_status', ['proposed', 'experimental', 'active', 'retired']);
export const jobStatus = pgEnum('job_status', ['queued', 'running', 'completed', 'failed']);
export const variantStatus = pgEnum('variant_status', ['pending', 'running', 'completed', 'failed', 'approved']);
export const revisionStatus = pgEnum('revision_status', ['ready', 'pending', 'failed']);
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
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => orgs.id),
    projectId: uuid('project_id').notNull(),
    kind: text('kind').notNull(), // upload | cutout | plate | broll | voice | render
    storageKey: text('storage_key').notNull(),
    mime: text('mime').notNull(),
    width: integer('width'),
    height: integer('height'),
    durationSec: doublePrecision('duration_sec'),
    bytes: integer('bytes').notNull(),
    sha256: text('sha256').notNull(),
    sourceUrl: text('source_url'),
    // Every column is named explicitly, as in assetsForInsert (assets-insert.ts): drizzle's casing cache is keyed by table name.
    /** Plate assets: { plate: PlateAnalysis, lumaGrid: number[][], depthKey: string }. Null until (or unless) analysed. */
    analysis: jsonb('analysis'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // (org_id, sha256) doubles as the org_id index.
  (t) => [
    // Constraint names pinned to their existing (key-derived) values, so naming the columns explicitly changes no migration.
    unique('assets_orgId_sha256_unique').on(t.orgId, t.sha256),
    unique('assets_id_orgId_unique').on(t.id, t.orgId),
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

/**
 * Content-addressed recipes (C2): `key` is recipeKey(recipe), which includes the org, so a hit never crosses orgs.
 * `output_key` is the storage key of what the recipe produced. Written by the pipeline on the owner connection; members read only.
 */
export const recipes = pgTable(
  'recipes',
  {
    key: text().primaryKey(),
    orgId: uuid().notNull().references(() => orgs.id),
    kind: text().notNull(),
    recipe: jsonb().notNull(),
    outputKey: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.orgId, t.kind)],
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
    /** The ProjectBase (variant + theme) revisions compile against; written at the spec step. NULL on legacy variants. */
    projectBase: jsonb(),
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

/**
 * A chain of edit-op revisions per variant; revision 0 (parent_id NULL, ops []) is the original generation and is created locked.
 * `ops` is this revision's OWN ops (the effective ops are the chain from revision 0). A locked revision is immutable: unlocking
 * means creating a child. Users insert/lock through the revision routes (column grants, migration 0017); the worker owns the rest.
 */
export const variantRevisions = pgTable(
  'variant_revisions',
  {
    id: id(),
    orgId: uuid().notNull().references(() => orgs.id),
    variantId: uuid().notNull(),
    parentId: uuid(),
    ops: jsonb().notNull(),
    beats: jsonb().notNull(),
    spec: jsonb(),
    status: revisionStatus().notNull(),
    locked: boolean().notNull().default(false),
    error: jsonb(),
    renderAssetId: uuid(),
    createdAt: createdAt(),
  },
  (t) => [
    unique().on(t.id, t.orgId),
    unique().on(t.id, t.variantId),
    index().on(t.variantId, t.createdAt),
    uniqueIndex().on(t.variantId).where(sql`${t.parentId} is null`),
    foreignKey({ columns: [t.variantId, t.orgId], foreignColumns: [variants.id, variants.orgId] }),
    // MATCH SIMPLE: a NULL parent_id / render_asset_id is not checked.
    // The parent must be in the same variant (and so the same org, via the composite FK above).
    foreignKey({ columns: [t.parentId, t.variantId], foreignColumns: [t.id, t.variantId] }),
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
