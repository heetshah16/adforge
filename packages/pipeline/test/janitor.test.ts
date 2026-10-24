import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { jobs, variantRevisions, variants } from '@adforge/db/schema';
import { failJob } from '../src/progress';
import { runJanitor } from '../src/janitor';
import { makeDeps } from './fakes';

describe('runJanitor', () => {
  it('frees GPU holders when idle and fails jobs that went silent', async () => {
    const m = await makeDeps();
    try {
      const old = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
      const [stale] = await m.deps.db.insert(jobs).values({ ...m.op, inputSpec: {}, status: 'running', progress: [{ stage: 'voice', status: 'running', at: old }] }).returning();
      const r = await runJanitor(m.deps);
      expect(r.stalled).toEqual([stale!.id]);
      const [j] = await m.deps.db.select().from(jobs).where(eq(jobs.id, stale!.id));
      expect(j!.status).toBe('failed');
      expect(JSON.stringify(j!.error)).toContain('stalled');
      expect(r.freed).toBe(true); // nothing running any more
      expect(m.calls.free).toBe(1);
      expect(m.calls.unload).toBe(1);
    } finally {
      await m.close();
    }
  });

  it('leaves a job with recent progress alone and does not free the GPU under it', async () => {
    const m = await makeDeps();
    try {
      await m.deps.db.insert(jobs).values({ ...m.op, inputSpec: {}, status: 'running', progress: [{ stage: 'voice', status: 'running', at: new Date().toISOString() }] });
      const r = await runJanitor(m.deps);
      expect(r).toEqual({ freed: false, stalled: [] });
      expect(m.calls.free + m.calls.unload).toBe(0);
    } finally {
      await m.close();
    }
  });
});

describe('runJanitor: edits', () => {
  async function pendingRevision(m: Awaited<ReturnType<typeof makeDeps>>, ageMin: number) {
    const [job] = await m.deps.db.insert(jobs).values({ ...m.op, inputSpec: {}, status: 'completed' }).returning();
    const [v] = await m.deps.db.insert(variants).values({ orgId: m.op.orgId, jobId: job!.id, variantNo: 1, formatSlug: 'f', hookSlug: 'h', archetypeSlug: 'a', visualTreatment: 'v', strategicBet: 'b', status: 'completed' }).returning();
    const [r] = await m.deps.db.insert(variantRevisions).values({ orgId: m.op.orgId, variantId: v!.id, ops: [], beats: [], status: 'pending', createdAt: new Date(Date.now() - ageMin * 60_000) }).returning();
    return r!.id;
  }
  const status = async (m: Awaited<ReturnType<typeof makeDeps>>, id: string) => (await m.deps.db.select().from(variantRevisions).where(eq(variantRevisions.id, id)))[0]!;

  it('fails a revision pending past the edit timeout', async () => {
    const m = await makeDeps();
    try {
      const id = await pendingRevision(m, 121);
      await runJanitor(m.deps);
      expect(await status(m, id)).toMatchObject({ status: 'failed', error: { message: 'edit timed out' } });
    } finally { await m.close(); }
  });

  it('a young pending revision is left alone and keeps the GPU holders loaded', async () => {
    const m = await makeDeps();
    try {
      const id = await pendingRevision(m, 5);
      const r = await runJanitor(m.deps);
      expect((await status(m, id)).status).toBe('pending');
      expect(r.freed).toBe(false);
      expect(m.calls.free + m.calls.unload).toBe(0);
    } finally { await m.close(); }
  });
});

describe('failJob', () => {
  it('fails a running job with the inngest stage and one progress entry, never a completed one', async () => {
    const m = await makeDeps();
    try {
      const [run] = await m.deps.db.insert(jobs).values({ ...m.op, inputSpec: {}, status: 'running' }).returning();
      const [done] = await m.deps.db.insert(jobs).values({ ...m.op, inputSpec: {}, status: 'completed' }).returning();
      expect(await failJob(m.deps.db, run!.id, 'boom')).toBe(true);
      expect(await failJob(m.deps.db, done!.id, 'boom')).toBe(false);
      const [a] = await m.deps.db.select().from(jobs).where(eq(jobs.id, run!.id));
      expect(a).toMatchObject({ status: 'failed', error: { stage: 'inngest', reason: 'boom' } });
      expect(a!.completedAt).toBeTruthy();
      expect(a!.progress).toHaveLength(1);
      const [b] = await m.deps.db.select().from(jobs).where(eq(jobs.id, done!.id));
      expect(b!.status).toBe('completed');
    } finally {
      await m.close();
    }
  });
});
