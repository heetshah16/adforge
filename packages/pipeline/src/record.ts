import { createHash } from 'node:crypto';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import { NonRetriableError } from 'inngest';
import { z } from 'zod';
import { MIME_EXT, STORAGE_KEY_RE } from '@adforge/core/providers/storage-key';
import type { MediaRef, ProviderResult, StorageProvider } from '@adforge/core/providers/types';
import { recipeKey, type Recipe } from '@adforge/core/recipe/index';
import type { Db } from '@adforge/db/client';
import { assetsForInsert } from '@adforge/db/assets-insert';
import { assets, jobs, products, providerCalls, recipes } from '@adforge/db/schema';
import { toWire, type WireResult } from './wire';

/** The job row is the only source of a pipeline write's org and project — never the worker's own config. */
export async function jobScope(db: Db, jobId: string): Promise<{ orgId: string; projectId: string }> {
  const [j] = await db.select({ orgId: jobs.orgId, projectId: jobs.projectId }).from(jobs).where(eq(jobs.id, jobId));
  if (!j) throw new NonRetriableError(`job ${jobId} not found`); // rows are never deleted: retrying cannot find it
  return j;
}

const EventRef = z.object({ jobId: z.uuid().optional(), productId: z.uuid().optional() });
/** The org owning an Inngest event's job (or, failing that, product): the storage scope its handler runs in. */
export async function orgForEvent(db: Db, data: { jobId?: string; productId?: string }): Promise<string> {
  const ref = EventRef.safeParse(data);
  if (!ref.success || !(ref.data.jobId ?? ref.data.productId)) throw new NonRetriableError('event names no valid jobId or productId');
  if (ref.data.jobId) return (await jobScope(db, ref.data.jobId)).orgId;
  const [p] = await db.select({ orgId: products.orgId }).from(products).where(eq(products.id, ref.data.productId!));
  if (!p) throw new NonRetriableError(`product ${ref.data.productId} not found`);
  return p.orgId;
}
/** The same, inline in an insert: one statement, no extra round trip. */
export const orgOfJob = (jobId: string): SQL => sql`(select ${jobs.orgId} from ${jobs} where ${jobs.id} = ${jobId})`;

const isWire = (r: unknown): r is WireResult<unknown> => typeof r === 'object' && r !== null && 'ok' in r;

/** A duplicate idempotency key means "already recorded" — never an error (retries re-enter here). */
export async function recordCall(
  db: Db,
  /** A job's call takes its org from the job row; a job-less call (product ingest) names its org. Exactly one of the two. */
  row: ({ jobId: string; orgId?: undefined } | { orgId: string; jobId?: undefined }) & {
    variantId?: string; kind: string; provider: string; model?: string; idempotencyKey: string;
    result: WireResult<unknown> | ProviderResult<unknown>; latencyMs?: number; costUsd?: number;
  },
): Promise<void> {
  const w = isWire(row.result) ? row.result : toWire(row.result);
  const fields = {
    jobId: row.jobId,
    variantId: row.variantId,
    kind: row.kind,
    provider: row.provider,
    model: row.model,
    latencyMs: row.latencyMs,
    costUsd: row.costUsd ?? 0,
    status: w.ok ? ('done' as const) : ('failed' as const),
    error: w.ok ? null : { code: w.code, message: w.message, retryable: w.retryable },
  };
  // A retry re-entering with the same key may now succeed: a later success replaces a
  // failure. A 'done' row is never overwritten, so a late duplicate failure can't undo it.
  await db
    .insert(providerCalls)
    .values({
      ...fields,
      orgId: row.orgId ?? orgOfJob(row.jobId as string),
      requestHash: createHash('sha256').update(row.idempotencyKey).digest('hex'),
      idempotencyKey: row.idempotencyKey,
    })
    .onConflictDoUpdate({
      target: providerCalls.idempotencyKey,
      set: fields,
      setWhere: sql`${providerCalls.status} <> 'done'`,
    });
}

/** Dedupes by (org, sha256): the same bytes uploaded twice in one org are one asset. */
export async function saveAsset(db: Db, scope: { orgId: string; projectId: string }, kind: string, ref: MediaRef): Promise<string> {
  const { orgId, projectId } = scope;
  await db
    .insert(assetsForInsert)
    .values({ orgId, projectId, kind, storageKey: ref.id, mime: ref.mime, width: ref.width, height: ref.height, durationSec: ref.durationSec, bytes: ref.bytes, sha256: ref.sha256 })
    .onConflictDoNothing();
  const [row] = await db.select({ id: assets.id }).from(assets).where(and(eq(assets.orgId, orgId), eq(assets.sha256, ref.sha256)));
  return row!.id;
}

/** Records what produced `outputKey`. The first output for a key wins: a later run with the same recipe is a cache hit, not a rewrite. */
export async function recordRecipe(db: Db, recipe: Recipe, outputKey: string): Promise<string> {
  const key = recipeKey(recipe);
  await db.insert(recipes).values({ key, orgId: recipe.orgId, kind: recipe.kind, recipe, outputKey }).onConflictDoNothing({ target: recipes.key });
  return key;
}

/** Scoped to the org as well as the key: a lookup can never return another org's output, even for a key built wrong. */
export async function findRecipe(db: Db, orgId: string, key: string): Promise<{ outputKey: string } | null> {
  const [r] = await db.select({ outputKey: recipes.outputKey }).from(recipes).where(and(eq(recipes.orgId, orgId), eq(recipes.key, key)));
  return r ?? null;
}

const MIME = Object.fromEntries(Object.entries(MIME_EXT).map(([mime, ext]) => [ext, mime]));
/** Dev and org-prefixed keys alike end `<sha256>.<ext>`. */
export async function refFromKey(storage: StorageProvider, key: string): Promise<MediaRef> {
  if (!STORAGE_KEY_RE.test(key)) throw new Error(`not a storage key: ${key}`);
  const bytes = await storage.read(key);
  const [, sha256, ext] = /([0-9a-f]{64})\.([a-z0-9]+)$/.exec(key)!;
  return { id: key, url: storage.urlFor(key), mime: MIME[ext!] ?? 'application/octet-stream', sha256: sha256!, bytes: bytes.byteLength };
}
