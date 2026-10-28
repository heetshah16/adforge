import { describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { jobs, variantRevisions, variants, workers } from '@adforge/db/schema';
import type { Db } from '@adforge/db/client';
import { failJob } from '../src/progress';
import { freeIdleGpu, runJanitor } from '../src/janitor';
import { makeDeps } from './fakes';

/** A heartbeat ageSec old from a worker online (continuously) for onlineMin minutes. */
const heartbeat = (db: Db, ageSec: number, onlineMin = 180) =>
  db.insert(workers).values({ instanceId: 'w', status: 'online', lastSeen: sql`now() - ${ageSec}::int * interval '1 second'`, onlineSince: sql`now() - ${onlineMin}::int * interval '1 minute'` });

describe('runJanitor', () => {
  async function staleRunning(m: Awaited<ReturnType<typeof makeDeps>>) {
    const old = new Date(Date.now() - 2 * 60 * 60_000 - 60_000).toISOString();
    const [stale] = await m.deps.db.insert(jobs).values({ ...m.op, inputSpec: {}, status: 'running', progress: [{ stage: 'voice', status: 'running', at: old }] }).returning();
    return stale!.id;
  }

  it('online: fails a running job that went silent past staleAfterMin, once', async () => {
    const m = await makeDeps();
    try {
      await heartbeat(m.deps.db, 5);
      const id = await staleRunning(m);
      const r = await runJanitor(m.deps.db);
      expect(r.stalled).toEqual([id]);
      const [j] = await m.deps.db.select().from(jobs).where(eq(jobs.id, id));
      expect(j!.status).toBe('failed');
      expect(JSON.stringify(j!.error)).toContain('stalled');
      expect((await runJanitor(m.deps.db)).stalled).toEqual([]);
    } finally {
      await m.close();
    }
  });

  it('Review Focus 1: offline (no or stale heartbeat), a silent running job is left alone (paused)', async () => {
    const m = await makeDeps();
    try {
      const id = await staleRunning(m);
      expect((await runJanitor(m.deps.db)).stalled).toEqual([]); // no worker row at all
      await heartbeat(m.deps.db, 180);
      expect((await runJanitor(m.deps.db)).stalled).toEqual([]);
      const [j] = await m.deps.db.select().from(jobs).where(eq(jobs.id, id));
      expect(j!.status).toBe('running');
    } finally {
      await m.close();
    }
  });

  it('I3: a worker that reconnected 5 min ago gives the silent job a fresh staleAfterMin window; online for 3 h -> failed', async () => {
    const m = await makeDeps();
    try {
      await heartbeat(m.deps.db, 5, 5);
      const id = await staleRunning(m);
      expect((await runJanitor(m.deps.db)).stalled).toEqual([]);
      expect((await m.deps.db.select().from(jobs).where(eq(jobs.id, id)))[0]!.status).toBe('running');
      await m.deps.db.update(workers).set({ onlineSince: sql`now() - interval '3 hours'` });
      expect((await runJanitor(m.deps.db)).stalled).toEqual([id]);
    } finally {
      await m.close();
    }
  });

  it('a malformed progress[-1].at does not abort the sweep: that row falls back to created_at, the others are still swept', async () => {
    const m = await makeDeps();
    try {
      await heartbeat(m.deps.db, 5);
      const [bad] = await m.deps.db.insert(jobs).values({ ...m.op, inputSpec: {}, status: 'running', createdAt: new Date(Date.now() - 3 * 60 * 60_000), progress: [{ stage: 'voice', status: 'running', at: 'not a date' }] }).returning();
      const [young] = await m.deps.db.insert(jobs).values({ ...m.op, inputSpec: {}, status: 'running', progress: [{ stage: 'voice', status: 'running', at: 'garbage' }] }).returning();
      const id = await staleRunning(m);
      expect((await runJanitor(m.deps.db)).stalled.sort()).toEqual([bad!.id, id].sort());
      expect((await m.deps.db.select().from(jobs).where(eq(jobs.id, young!.id)))[0]!.status).toBe('running');
    } finally {
      await m.close();
    }
  });

  it('online: leaves a job with recent progress alone', async () => {
    const m = await makeDeps();
    try {
      await heartbeat(m.deps.db, 5);
      await m.deps.db.insert(jobs).values({ ...m.op, inputSpec: {}, status: 'running', progress: [{ stage: 'voice', status: 'running', at: new Date().toISOString() }] });
      expect(await runJanitor(m.deps.db)).toEqual({ stalled: [], lost: [] });
    } finally {
      await m.close();
    }
  });

  it('M1: a running job with no progress counts from the later of created_at and dispatched_at (created 5 h ago, dispatched 10 min ago -> kept)', async () => {
    const m = await makeDeps();
    try {
      await heartbeat(m.deps.db, 5);
      const [j] = await m.deps.db.insert(jobs).values({ ...m.op, inputSpec: {}, status: 'running', createdAt: sql`now() - interval '5 hours'`, dispatchedAt: sql`now() - interval '10 minutes'` }).returning();
      expect((await runJanitor(m.deps.db)).stalled).toEqual([]);
      expect((await m.deps.db.select().from(jobs).where(eq(jobs.id, j!.id)))[0]!.status).toBe('running');
    } finally {
      await m.close();
    }
  });
});

describe('runJanitor: lost dispatches', () => {
  /** A queued job created 5 h ago, dispatched dispatchedMin minutes ago (null: never dispatched). */
  const queued = async (m: Awaited<ReturnType<typeof makeDeps>>, dispatchedMin: number | null) => {
    const [j] = await m.deps.db.insert(jobs).values({ ...m.op, inputSpec: {}, createdAt: sql`now() - interval '5 hours'`,
      dispatchedAt: dispatchedMin === null ? null : sql`now() - ${dispatchedMin}::int * interval '1 minute'` }).returning();
    return j!.id;
  };
  const row = async (m: Awaited<ReturnType<typeof makeDeps>>, id: string) => (await m.deps.db.select().from(jobs).where(eq(jobs.id, id)))[0]!;

  it('fails a job dispatched > 120 min ago that never started, while online for > 120 min, once', async () => {
    const m = await makeDeps();
    try {
      await heartbeat(m.deps.db, 5, 180);
      const id = await queued(m, 150);
      expect(await runJanitor(m.deps.db)).toEqual({ stalled: [], lost: [id] });
      expect(await row(m, id)).toMatchObject({ status: 'failed', error: { stage: 'janitor', reason: 'dispatched but never started' } });
      expect((await row(m, id)).completedAt).toBeInstanceOf(Date);
      expect((await runJanitor(m.deps.db)).lost).toEqual([]);
    } finally {
      await m.close();
    }
  });

  it('keeps it after a fresh reconnect (online_since recent)', async () => {
    const m = await makeDeps();
    try {
      await heartbeat(m.deps.db, 5, 5);
      const id = await queued(m, 150);
      expect((await runJanitor(m.deps.db)).lost).toEqual([]);
      expect((await row(m, id)).status).toBe('queued');
    } finally {
      await m.close();
    }
  });

  it('never touches an undispatched queued job, nor any job while offline', async () => {
    const m = await makeDeps();
    try {
      const lostOffline = await queued(m, 150);
      expect((await runJanitor(m.deps.db)).lost).toEqual([]); // no worker
      await heartbeat(m.deps.db, 5, 180);
      const undispatched = await queued(m, null);
      expect((await runJanitor(m.deps.db)).lost).toEqual([lostOffline]);
      expect((await row(m, undispatched)).status).toBe('queued');
    } finally {
      await m.close();
    }
  });
});

describe('freeIdleGpu (the adforge-gpu gpu-idle cron)', () => {
  it('frees ComfyUI and voice when nothing is running or pending', async () => {
    const m = await makeDeps();
    try {
      await m.deps.db.insert(jobs).values({ ...m.op, inputSpec: {}, status: 'failed' });
      expect(await freeIdleGpu(m.deps)).toBe(true);
      expect([m.calls.free, m.calls.unload]).toEqual([1, 1]);
    } finally {
      await m.close();
    }
  });

  it('keeps the GPU holders loaded under a running job', async () => {
    const m = await makeDeps();
    try {
      await m.deps.db.insert(jobs).values({ ...m.op, inputSpec: {}, status: 'running' });
      expect(await freeIdleGpu(m.deps)).toBe(false);
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

  it('a revision still queued within the start + finish window is not failed', async () => {
    const m = await makeDeps();
    try {
      const id = await pendingRevision(m, 200);
      await runJanitor(m.deps.db);
      expect((await status(m, id)).status).toBe('pending');
    } finally { await m.close(); }
  });

  it('fails a revision pending past the edit timeout', async () => {
    const m = await makeDeps();
    try {
      const id = await pendingRevision(m, 241);
      await runJanitor(m.deps.db);
      expect(await status(m, id)).toMatchObject({ status: 'failed', error: { message: 'edit timed out' } });
    } finally { await m.close(); }
  });

  it('a young pending revision is left alone and keeps the GPU holders loaded', async () => {
    const m = await makeDeps();
    try {
      const id = await pendingRevision(m, 5);
      await runJanitor(m.deps.db);
      expect((await status(m, id)).status).toBe('pending');
      expect(await freeIdleGpu(m.deps)).toBe(false);
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
