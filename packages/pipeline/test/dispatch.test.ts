import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import { openDb, openPostgres, type Db } from '@adforge/db/client';
import { jobs, workers } from '@adforge/db/schema';
import { seedOperator } from '@adforge/db/seed/seed';
import { GENERATE_ADS_CONCURRENCY, runDispatcher, workerOnline, type JobEvent } from '../src/dispatch';
import { createLightFunctions } from '../src/light';
import { inngest } from '../src/inngest';

let close: (() => Promise<void>) | undefined;
afterEach(async () => { await close?.(); close = undefined; });

async function pglite() {
  const h = await openDb();
  close = h.close;
  return { db: h.db, op: await seedOperator(h.db) };
}
/** A heartbeat `ageSec` old, on the SQL clock. */
const beat = (db: Db, ageSec: number, instanceId = `w-${randomUUID()}`) =>
  db.insert(workers).values({ instanceId, status: 'online', lastSeen: sql`now() - ${ageSec}::int * interval '1 second'` });
/** Queued jobs, oldest first (`ageMin` minutes before the SQL now()). */
async function queue(db: Db, op: { orgId: string; userId: string; projectId: string }, agesMin: number[]): Promise<string[]> {
  const ids: string[] = [];
  for (const age of agesMin) {
    const [j] = await db.insert(jobs).values({ ...op, inputSpec: {}, createdAt: sql`now() - ${age}::int * interval '1 minute'` }).returning({ id: jobs.id });
    ids.push(j!.id);
  }
  return ids;
}
const recorder = (failOn?: number) => {
  const sent: JobEvent[] = [];
  let n = 0;
  return { sent, send: async (e: JobEvent) => { if (++n === failOn) throw new Error('inngest down'); sent.push(e); } };
};
const row = async (db: Db, id: string) => (await db.select().from(jobs).where(eq(jobs.id, id)))[0]!;

describe('workerOnline', () => {
  it('is true only for an online heartbeat within heartbeatFreshSec, on the SQL clock', async () => {
    const { db } = await pglite();
    expect(await workerOnline(db)).toBe(false); // no worker at all
    await beat(db, 180);
    expect(await workerOnline(db)).toBe(false); // 3 min old
    await db.insert(workers).values({ instanceId: 'stopped', status: 'offline', lastSeen: sql`now()` });
    expect(await workerOnline(db)).toBe(false); // a clean stop never counts
    await beat(db, 10);
    expect(await workerOnline(db)).toBe(true);
  });
});

describe('runDispatcher', () => {
  it('Review Focus 1: a stale heartbeat (3 min) -> 0 sends, 0 claims', async () => {
    const { db, op } = await pglite();
    await beat(db, 180);
    const ids = await queue(db, op, [3, 2, 1]);
    const r = recorder();
    await runDispatcher(db, r.send);
    expect(r.sent).toEqual([]);
    for (const id of ids) expect(await row(db, id)).toMatchObject({ status: 'queued', dispatchedAt: null });
  });

  it('F1c: 0 in flight, 3 queued -> the 2 oldest sent in created_at order, id job:<id>, dispatched_at set', async () => {
    const { db, op } = await pglite();
    await beat(db, 5);
    const [mid, newest, oldest] = await queue(db, op, [2, 1, 3]);
    const r = recorder();
    await runDispatcher(db, r.send);
    expect(r.sent).toEqual([oldest, mid].map((jobId) => ({ name: 'adforge/job.requested', data: { jobId, priority: 'job' }, id: `job:${jobId}` })));
    for (const id of [oldest!, mid!]) expect((await row(db, id)).dispatchedAt).toBeInstanceOf(Date);
    expect((await row(db, newest!)).dispatchedAt).toBeNull();
    // A second run finds no capacity: both claimed jobs are still in flight.
    await runDispatcher(db, r.send);
    expect(r.sent).toHaveLength(2);
    // One finishes: the next run sends the newest.
    await db.update(jobs).set({ status: 'completed' }).where(eq(jobs.id, oldest!));
    await runDispatcher(db, r.send);
    expect(r.sent.map((e) => e.data.jobId)).toEqual([oldest, mid, newest]);
  });

  it('F1a: 2 in flight (one dispatched+queued, one running) -> nothing sent', async () => {
    const { db, op } = await pglite();
    await beat(db, 5);
    const [q, run, waiting] = await queue(db, op, [5, 4, 1]);
    await db.update(jobs).set({ dispatchedAt: sql`now()` }).where(eq(jobs.id, q!));
    await db.update(jobs).set({ dispatchedAt: sql`now()`, status: 'running' }).where(eq(jobs.id, run!));
    const r = recorder();
    expect((await runDispatcher(db, r.send)).sent).toEqual([]);
    expect(r.sent).toEqual([]);
    expect((await row(db, waiting!)).dispatchedAt).toBeNull();
  });

  it('F1b: 1 in flight + 3 undispatched -> exactly the oldest 1 sent', async () => {
    const { db, op } = await pglite();
    await beat(db, 5);
    const [run, a, b, c] = await queue(db, op, [10, 3, 2, 1]);
    await db.update(jobs).set({ dispatchedAt: sql`now()`, status: 'running' }).where(eq(jobs.id, run!));
    const r = recorder();
    await runDispatcher(db, r.send);
    expect(r.sent.map((e) => e.data.jobId)).toEqual([a]);
    for (const id of [b!, c!]) expect((await row(db, id)).dispatchedAt).toBeNull();
  });

  it('claims at most GENERATE_ADS_CONCURRENCY per run, oldest first', async () => {
    const { db, op } = await pglite();
    await beat(db, 5);
    const ids = await queue(db, op, Array.from({ length: 12 }, (_, i) => 100 - i));
    const r = recorder();
    await runDispatcher(db, r.send);
    expect(r.sent.map((e) => e.data.jobId)).toEqual(ids.slice(0, GENERATE_ADS_CONCURRENCY));
  });

  it('Review Focus 2: two concurrent runs (PGlite) -> no job sent twice, and together they stay within capacity', async () => {
    const { db, op } = await pglite();
    await beat(db, 5);
    const ids = await queue(db, op, [4, 3, 2, 1]);
    const r = recorder();
    await Promise.all([runDispatcher(db, r.send), runDispatcher(db, r.send)]);
    expect(r.sent.map((e) => e.data.jobId)).toEqual(ids.slice(0, 2));
  });

  it('I1: a send that throws mid-batch rolls the whole claim back (no job left claimed); the next run sends up to capacity', async () => {
    const { db, op } = await pglite();
    await beat(db, 5);
    const [a, b, c] = await queue(db, op, [3, 2, 1]);
    const r = recorder(2);
    await expect(runDispatcher(db, r.send)).rejects.toThrow('inngest down');
    expect(r.sent.map((e) => e.data.jobId)).toEqual([a]); // a landed before the rollback
    for (const id of [a!, b!, c!]) expect((await row(db, id)).dispatchedAt).toBeNull();
    await runDispatcher(db, r.send);
    // a is re-sent with the same id job:<a>; Inngest's event-id dedupe drops the second copy.
    expect(r.sent.map((e) => e.id)).toEqual([a, a, b].map((id) => `job:${id}`));
    for (const id of [a!, b!]) expect((await row(db, id)).dispatchedAt).toBeInstanceOf(Date);
    expect((await row(db, c!)).dispatchedAt).toBeNull();
  });

  it('I1: a hung send times out, so it cannot hold the claim; nothing stays claimed', async () => {
    const { db, op } = await pglite();
    await beat(db, 5);
    const [a] = await queue(db, op, [1]);
    await expect(runDispatcher(db, () => new Promise(() => {}), { sendTimeoutMs: 50 })).rejects.toThrow(/timed out/);
    expect((await row(db, a!)).dispatchedAt).toBeNull();
  });

  it('Review Focus 4: offline, a job queued 25 h ago is failed (failJob shape), exactly once over two runs; a younger one waits', async () => {
    const { db, op } = await pglite();
    await beat(db, 600); // stale
    const [old, young] = await queue(db, op, [25 * 60, 23 * 60]);
    const r = recorder();
    const first = await runDispatcher(db, r.send);
    const failedAt = (await row(db, old!)).completedAt;
    const second = await runDispatcher(db, r.send);
    expect(first.failed).toEqual([old]);
    expect(second.failed).toEqual([]);
    expect(await row(db, old!)).toMatchObject({ status: 'failed', error: { stage: 'dispatch', reason: 'GPU offline for 24 h' }, dispatchedAt: null });
    expect((await row(db, old!)).progress).toEqual([expect.objectContaining({ stage: 'dispatch', status: 'failed', detail: 'GPU offline for 24 h' })]);
    expect((await row(db, old!)).completedAt).toEqual(failedAt);
    expect(await row(db, young!)).toMatchObject({ status: 'queued', dispatchedAt: null });
    expect(r.sent).toEqual([]);
  });

  it('I2: offline, a job DISPATCHED but still queued past 24 h is failed too (it would otherwise wait forever)', async () => {
    const { db, op } = await pglite();
    await beat(db, 600);
    const [old] = await queue(db, op, [25 * 60]);
    await db.update(jobs).set({ dispatchedAt: sql`now() - interval '24 hours'` }).where(eq(jobs.id, old!));
    await db.insert(jobs).values({ ...op, inputSpec: {}, status: 'running', createdAt: sql`now() - interval '30 hours'` });
    const r = await runDispatcher(db, recorder().send);
    expect(r.failed).toEqual([old]); // a running job is the janitor's, not the offline bound's
    expect((await row(db, old!)).status).toBe('failed');
  });

  it('Review Focus 4: online, the same 25 h old job is dispatched instead', async () => {
    const { db, op } = await pglite();
    await beat(db, 5);
    const [old] = await queue(db, op, [25 * 60]);
    const r = recorder();
    await runDispatcher(db, r.send);
    expect(r.sent.map((e) => e.data.jobId)).toEqual([old]);
    expect((await row(db, old!)).status).toBe('queued');
  });

  it('never claims a job that is not queued', async () => {
    const { db, op } = await pglite();
    await beat(db, 5);
    await db.insert(jobs).values({ ...op, inputSpec: {}, status: 'running' });
    const r = recorder();
    await runDispatcher(db, r.send);
    expect(r.sent).toEqual([]);
  });
});

describe('createLightFunctions (the adforge-web app)', () => {
  it('holds the dispatcher (cron each minute + nudge, limit 1, retries 2) and the janitor, nothing GPU-side', async () => {
    const fns = createLightFunctions(inngest, async () => { throw new Error('unused'); });
    const byId = new Map(fns.map((f) => [f.id(), f]));
    expect([...byId.keys()].sort()).toEqual(['dispatcher', 'janitor']);
    expect(byId.get('dispatcher')!.opts).toMatchObject({ triggers: [{ cron: '* * * * *' }, { event: 'adforge/dispatch.nudge' }], concurrency: [{ limit: 1 }], retries: 2 });
    expect(byId.get('janitor')!.opts).toMatchObject({ triggers: [{ cron: '*/5 * * * *' }], concurrency: [{ limit: 1 }] });
  });
});

// Real locks need real connections (PGlite has one). Runs against Postgres when ADFORGE_TEST_DATABASE_URL is set.
// Point ADFORGE_TEST_DATABASE_URL at a throwaway DB: live dispatchers on a shared DB can pick up its rows (and its in-flight jobs eat the capacity).
describe.skipIf(!process.env.ADFORGE_TEST_DATABASE_URL)('Review Focus 2 on Postgres', () => {
  it.each([1, 2, 3])('dispatcher B, run while A holds its claim open, waits on the advisory lock, then claims none of A\'s jobs; A sends each once (round %i)', async () => {
    const h = await openPostgres(process.env.ADFORGE_TEST_DATABASE_URL!, { migrate: false });
    const instanceId = `test-${randomUUID()}`; // unique and deleted below: never leave a fresh 'online' row on the shared DB
    let ours: string[] = [];
    const sent: JobEvent[] = [];
    try {
      const op = await seedOperator(h.db);
      await beat(h.db, 0, instanceId);
      // Older than anything real, so these are the ones claimed first.
      ours = await queue(h.db, op, [30 * 365 * 24 * 60 + 2, 30 * 365 * 24 * 60 + 1]); // GENERATE_ADS_CONCURRENCY of them
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      let holding!: () => void;
      const aHolds = new Promise<void>((r) => { holding = r; });
      // A blocks inside its first send: its claim transaction is open and its rows are locked.
      const a = runDispatcher(h.db, async (e) => { sent.push(e); holding(); await gate; }, { sendTimeoutMs: 30_000 });
      await aHolds;
      // B on another pooled connection. Any send it makes throws, rolling B back, so B commits nothing on the shared DB.
      // B blocks on A's advisory lock; once A commits, A's jobs are in flight, so B has no capacity left for them.
      const seenB: string[] = [];
      let bDone = false;
      const b = runDispatcher(h.db, async (e) => { seenB.push(e.data.jobId); throw new Error('rollback B'); })
        .catch((e: Error) => { if (e.message !== 'rollback B') throw e; })
        .finally(() => { bDone = true; });
      await new Promise((r) => setTimeout(r, 500));
      expect(bDone).toBe(false); // still waiting on A's lock
      release();
      await a;
      await b;
      expect(seenB.filter((id) => ours.includes(id))).toEqual([]);
      const counts = new Map<string, number>();
      for (const e of sent) counts.set(e.data.jobId, (counts.get(e.data.jobId) ?? 0) + 1);
      for (const id of ours) expect(counts.get(id), id).toBe(1);
      expect([...counts.values()].every((n) => n === 1)).toBe(true);
    } finally {
      // ponytail: a shared dev DB may hold real queued jobs; A's fake send never reached Inngest, so un-claim any it took.
      const foreign = sent.map((e) => e.data.jobId).filter((id) => !ours.includes(id));
      if (foreign.length) await h.db.update(jobs).set({ dispatchedAt: null }).where(inArray(jobs.id, foreign));
      if (ours.length) await h.db.delete(jobs).where(inArray(jobs.id, ours));
      await h.db.delete(workers).where(eq(workers.instanceId, instanceId));
      await h.close();
    }
  }, 60_000);
});
