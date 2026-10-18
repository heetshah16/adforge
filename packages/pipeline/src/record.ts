import { createHash } from 'node:crypto';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import type { MediaRef, ProviderResult, StorageProvider } from '@adforge/core/providers/types';
import type { Db } from '@adforge/db/client';
import { assets, jobs, providerCalls } from '@adforge/db/schema';
import { toWire, type WireResult } from './wire';

/** The job row is the only source of a pipeline write's org and project — never the worker's own config. */
export async function jobScope(db: Db, jobId: string): Promise<{ orgId: string; projectId: string }> {
  const [j] = await db.select({ orgId: jobs.orgId, projectId: jobs.projectId }).from(jobs).where(eq(jobs.id, jobId));
  if (!j) throw new Error(`job ${jobId} not found`);
  return j;
}
/** The same, inline in an insert: one statement, no extra round trip. */
export const orgOfJob = (jobId: string): SQL => sql`(select ${jobs.orgId} from ${jobs} where ${jobs.id} = ${jobId})`;

const isWire = (r: unknown): r is WireResult<unknown> => typeof r === 'object' && r !== null && 'ok' in r;

/** A duplicate idempotency key means "already recorded" — never an error (retries re-enter here). */
export async function recordCall(
  db: Db,
  row: {
    jobId: string; variantId?: string; kind: string; provider: string; model?: string; idempotencyKey: string;
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
      orgId: orgOfJob(row.jobId),
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
    .insert(assets)
    .values({ orgId, projectId, kind, storageKey: ref.id, mime: ref.mime, width: ref.width, height: ref.height, durationSec: ref.durationSec, bytes: ref.bytes, sha256: ref.sha256 })
    .onConflictDoNothing();
  const [row] = await db.select({ id: assets.id }).from(assets).where(and(eq(assets.orgId, orgId), eq(assets.sha256, ref.sha256)));
  return row!.id;
}

const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', mp4: 'video/mp4', wav: 'audio/wav' };
export async function refFromKey(storage: StorageProvider, key: string): Promise<MediaRef> {
  const bytes = await storage.read(key);
  const ext = key.split('.').pop()!;
  return { id: key, url: storage.urlFor(key), mime: MIME[ext] ?? 'application/octet-stream', sha256: key.slice(3, 67), bytes: bytes.byteLength };
}
