import { describe, expect, it } from 'vitest';
import { openDb } from '@adforge/db/client';
import { providerCalls } from '@adforge/db/schema';
import { seedLocalUser } from '@adforge/db/seed/seed';
import { jobs } from '@adforge/db/schema';
import { buildConfigSnapshot } from '../src/snapshot';
import { recordCall } from '../src/record';
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
