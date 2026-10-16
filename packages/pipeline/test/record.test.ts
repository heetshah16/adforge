import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '@adforge/db/client';
import { jobs, providerCalls } from '@adforge/db/schema';
import { seedLocalUser } from '@adforge/db/seed/seed';
import { LocalDiskStorage } from '@adforge/provider-local-storage';
import { buildConfigSnapshot } from '../src/snapshot';
import { recordCall, refFromKey } from '../src/record';
import { markProgress } from '../src/progress';
import { parseEnv } from '@adforge/core/config/env';
import { eq } from 'drizzle-orm';

describe('recordCall', () => {
  it('records once per idempotency key, flattening provider errors', async () => {
    const { db, close } = await openDb();
    try {
      const { userId, projectId } = await seedLocalUser(db);
      const [job] = await db.insert(jobs).values({ projectId, userId, inputSpec: {} }).returning();
      const row = { jobId: job!.id, kind: 'image', provider: 'comfyui', idempotencyKey: 'j:plate:1:0', result: { ok: false as const, code: 'UPSTREAM' as const, message: 'oom', retryable: true } };
      await recordCall(db, row);
      await recordCall(db, row); // retry re-entry
      const rows = await db.select().from(providerCalls);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: 'failed', error: { code: 'UPSTREAM', message: 'oom', retryable: true } });
      await markProgress(db, job!.id, 'plates', 'running');
      await markProgress(db, job!.id, 'plates', 'done', '12 plates');
      const [j] = await db.select().from(jobs).where(eq(jobs.id, job!.id));
      expect(j!.progress.map((p) => `${p.stage}:${p.status}`)).toEqual(['plates:running', 'plates:done']);
    } finally {
      await close();
    }
  });
});

describe('recordCall upsert', () => {
  const ok = { ok: true as const, value: 'x' };
  const fail = { ok: false as const, code: 'TIMEOUT' as const, message: 'still pending', retryable: true };

  it('a later success replaces an earlier failure with the same key', async () => {
    const { db, close } = await openDb();
    try {
      const { userId, projectId } = await seedLocalUser(db);
      const [job] = await db.insert(jobs).values({ projectId, userId, inputSpec: {} }).returning();
      const base = { jobId: job!.id, kind: 'image', provider: 'comfyui', idempotencyKey: 'k:retry' };
      await recordCall(db, { ...base, result: fail });
      await recordCall(db, { ...base, result: ok, costUsd: 0.02 });
      const rows = await db.select().from(providerCalls);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: 'done', error: null, costUsd: 0.02 });
    } finally {
      await close();
    }
  });

  it('a late failure never overwrites a done row', async () => {
    const { db, close } = await openDb();
    try {
      const { userId, projectId } = await seedLocalUser(db);
      const [job] = await db.insert(jobs).values({ projectId, userId, inputSpec: {} }).returning();
      const base = { jobId: job!.id, kind: 'image', provider: 'comfyui', idempotencyKey: 'k:late' };
      await recordCall(db, { ...base, result: ok });
      await recordCall(db, { ...base, result: fail });
      const rows = await db.select().from(providerCalls);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: 'done', error: null });
    } finally {
      await close();
    }
  });

  it('two successes with the same key leave one row', async () => {
    const { db, close } = await openDb();
    try {
      const { userId, projectId } = await seedLocalUser(db);
      const [job] = await db.insert(jobs).values({ projectId, userId, inputSpec: {} }).returning();
      const base = { jobId: job!.id, kind: 'image', provider: 'comfyui', idempotencyKey: 'k:twice' };
      await recordCall(db, { ...base, result: ok });
      await recordCall(db, { ...base, result: ok });
      expect(await db.select().from(providerCalls)).toHaveLength(1);
    } finally {
      await close();
    }
  });
});

describe('refFromKey', () => {
  it('takes the MediaRef url from storage.urlFor, never the bare key', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adforge-ref-'));
    try {
      const storage = new LocalDiskStorage(root, 'http://localhost:3000');
      const ref = await storage.put(new TextEncoder().encode('png bytes'), { mime: 'image/png' });
      const got = await refFromKey(storage, ref.id);
      expect(got.url).toBe(`http://localhost:3000/media/${ref.id}`);
      expect(got.sha256).toBe(ref.sha256);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('buildConfigSnapshot', () => {
  it('records what ran and never leaks secret-looking env values', () => {
    const env = parseEnv({ ADFORGE_LLM_DIRECTOR: 'claude-opus-5-5' });
    const secretish = { ...env, OPENROUTER_API_KEY: 'sk-SECRET-123', ANTHROPIC_API_KEY: 'sk-ant-SECRET' } as typeof env;
    const s = buildConfigSnapshot({ env: secretish, workflowHashes: { 'plate-flux-schnell': 'a'.repeat(64) } });
    const json = JSON.stringify(s);
    expect(json).not.toContain('SECRET');
    expect(s).toMatchObject({ models: { director: 'claude-opus-5-5' }, comfyWorkflows: { hashes: { 'plate-flux-schnell': 'a'.repeat(64) } } });
    expect((s.prompts as { director: string }).director).toMatch(/^[0-9a-f]{64}$/);
  });
});
