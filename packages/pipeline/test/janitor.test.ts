import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { jobs } from '@adforge/db/schema';
import { failJob } from '../src/progress';
import { runJanitor } from '../src/janitor';
import { makeDeps } from './fakes';

describe('runJanitor', () => {
  it('frees GPU holders when idle and fails jobs that went silent', async () => {
    const m = await makeDeps();
    try {
      const old = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
      const [stale] = await m.deps.db.insert(jobs).values({ projectId: m.deps.projectId, userId: m.deps.userId, inputSpec: {}, status: 'running', progress: [{ stage: 'voice', status: 'running', at: old }] }).returning();
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
      await m.deps.db.insert(jobs).values({ projectId: m.deps.projectId, userId: m.deps.userId, inputSpec: {}, status: 'running', progress: [{ stage: 'voice', status: 'running', at: new Date().toISOString() }] });
      const r = await runJanitor(m.deps);
      expect(r).toEqual({ freed: false, stalled: [] });
      expect(m.calls.free + m.calls.unload).toBe(0);
    } finally {
      await m.close();
    }
  });
});

describe('failJob', () => {
  it('fails a running job with the inngest stage and one progress entry, never a completed one', async () => {
    const m = await makeDeps();
    try {
      const [run] = await m.deps.db.insert(jobs).values({ projectId: m.deps.projectId, userId: m.deps.userId, inputSpec: {}, status: 'running' }).returning();
      const [done] = await m.deps.db.insert(jobs).values({ projectId: m.deps.projectId, userId: m.deps.userId, inputSpec: {}, status: 'completed' }).returning();
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
