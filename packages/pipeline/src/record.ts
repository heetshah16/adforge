import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { MediaRef, ProviderResult, StorageProvider } from '@adforge/core/providers/types';
import type { Db } from '@adforge/db/client';
import { assets, providerCalls } from '@adforge/db/schema';
import { toWire, type WireResult } from './wire';

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
  await db
    .insert(providerCalls)
    .values({
      jobId: row.jobId,
      variantId: row.variantId,
      kind: row.kind,
      provider: row.provider,
      model: row.model,
      requestHash: createHash('sha256').update(row.idempotencyKey).digest('hex'),
      idempotencyKey: row.idempotencyKey,
      latencyMs: row.latencyMs,
      costUsd: row.costUsd ?? 0,
      status: w.ok ? 'done' : 'failed',
      error: w.ok ? null : { code: w.code, message: w.message, retryable: w.retryable },
    })
    .onConflictDoNothing({ target: providerCalls.idempotencyKey });
}

export async function saveAsset(db: Db, projectId: string, kind: string, ref: MediaRef): Promise<string> {
  await db
    .insert(assets)
    .values({ projectId, kind, storageKey: ref.id, mime: ref.mime, width: ref.width, height: ref.height, durationSec: ref.durationSec, bytes: ref.bytes, sha256: ref.sha256 })
    .onConflictDoNothing();
  const [row] = await db.select({ id: assets.id }).from(assets).where(and(eq(assets.projectId, projectId), eq(assets.sha256, ref.sha256)));
  return row!.id;
}

const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', mp4: 'video/mp4', wav: 'audio/wav' };
export async function refFromKey(storage: StorageProvider & { pathFor?(k: string): string }, key: string): Promise<MediaRef> {
  const bytes = await storage.read(key);
  const ext = key.split('.').pop()!;
  return { id: key, url: key, mime: MIME[ext] ?? 'application/octet-stream', sha256: key.slice(3, 67), bytes: bytes.byteLength };
}
