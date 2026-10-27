import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import { openDb, openPostgres, type Db } from '@adforge/db/client';
import { jobs, workers } from '@adforge/db/schema';
import { seedOperator } from '@adforge/db/seed/seed';
import { runDispatcher, workerOnline, type JobEvent } from '../src/dispatch';
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

  it('a fresh heartbeat: 3 queued jobs -> 3 sends in created_at order, id job:<id>, dispatched_at set', async () => {
    const { db, op } = await pglite();
    await beat(db, 5);
    const [mid, newest, oldest] = await queue(db, op, [2, 1, 3]);
    const r = recorder();
    await runDispatcher(db, r.send);
    expect(r.sent).toEqual([oldest, mid, newest].map((jobId) => ({ name: 'adforge/job.requested', data: { jobId, priority: 'job' }, id: `job:${jobId}` })));
    for (const id of [oldest!, mid!, newest!]) expect((await row(db, id)).dispatchedAt).toBeInstanceOf(Date);
    // A second run finds nothing left to claim.
    await runDispatcher(db, r.send);
    expect(r.sent).toHaveLength(3);
  });

  it('claims at most 10 per run, oldest first', async () => {
    const { db, op } = await pglite();
    await beat(db, 5);
    const ids = await queue(db, op, Array.from({ length: 12 }, (_, i) => 100 - i));
    const r = recorder();
    await runDispatcher(db, r.send);
    expect(r.sent.map((e) => e.data.jobId)).toEqual(ids.slice(0, 10));
  });

  it('Review Focus 2: two concurrent runs (PGlite) -> each job sent exactly once', async () => {
    const { db, op } = await pglite();
    await beat(db, 5);
    const ids = await queue(db, op, [4, 3, 2, 1]);
    const r = recorder();
    await Promise.all([runDispatcher(db, r.send), runDispatcher(db, r.send)]);
    expect(r.sent.map((e) => e.data.jobId).sort()).toEqual([...ids].sort());
  });

  it('a send failure resets dispatched_at for the unsent jobs and rethrows; the next run sends them', async () => {
    const { db, op } = await pglite();
    await beat(db, 5);
    const [a, b, c] = await queue(db, op, [3, 2, 1]);
    const r = recorder(2);
    await expect(runDispatcher(db, r.send)).rejects.toThrow('inngest down');
    expect(r.sent.map((e) => e.data.jobId)).toEqual([a]);
    expect((await row(db, a!)).dispatchedAt).toBeInstanceOf(Date);
    expect((await row(db, b!)).dispatchedAt).toBeNull();
    expect((await row(db, c!)).dispatchedAt).toBeNull();
    await runDispatcher(db, r.send);
    expect(r.sent.map((e) => e.data.jobId)).toEqual([a, b, c]);
  });

  it('Review Focus 4: offline, a job queued 25 h ago is failed with "GPU offline for 24 h", exactly once over two runs; a younger one waits', async () => {
    const { db, op } = await pglite();
    await beat(db, 600); // stale
    const [old, young] = await queue(db, op, [25 * 60, 23 * 60]);
    const r = recorder();
    const first = await runDispatcher(db, r.send);
    const failedAt = (await row(db, old!)).completedAt;
    const second = await runDispatcher(db, r.send);
    expect(first.failed).toEqual([old]);
    expect(second.failed).toEqual([]);
    expect(await row(db, old!)).toMatchObject({ status: 'failed', error: { message: 'GPU offline for 24 h' }, dispatchedAt: null });
    expect((await row(db, old!)).completedAt).toEqual(failedAt);
    expect(await row(db, young!)).toMatchObject({ status: 'queued', dispatchedAt: null });
    expect(r.sent).toEqual([]);
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

// Real row locks need real connections (PGlite has one). Runs against the dev database when ADFORGE_TEST_DATABASE_URL is set.
describe.skipIf(!process.env.ADFORGE_TEST_DATABASE_URL)('Review Focus 2 on Postgres', () => {
  it.each([1, 2, 3])('two concurrent dispatchers send each job exactly once (round %i)', async () => {
    const h = await openPostgres(process.env.ADFORGE_TEST_DATABASE_URL!, { migrate: false });
    const instanceId = `test-${randomUUID()}`;
    let ours: string[] = [];
    const sent: JobEvent[] = [];
    try {
      const op = await seedOperator(h.db);
      await beat(h.db, 0, instanceId);
      // Older than anything real, so these are the ones claimed first.
      ours = await queue(h.db, op, [30 * 365 * 24 * 60 + 3, 30 * 365 * 24 * 60 + 2, 30 * 365 * 24 * 60 + 1]);
      const send = async (e: JobEvent) => { await new Promise((r) => setTimeout(r, 20)); sent.push(e); };
      await Promise.all([runDispatcher(h.db, send), runDispatcher(h.db, send)]);
      const counts = new Map<string, number>();
      for (const e of sent) counts.set(e.data.jobId, (counts.get(e.data.jobId) ?? 0) + 1);
      for (const id of ours) expect(counts.get(id), id).toBe(1);
      expect([...counts.values()].every((n) => n === 1)).toBe(true);
    } finally {
      // ponytail: a shared dev DB may hold real queued jobs; the fake send never reached Inngest, so un-claim any we took.
      const foreign = sent.map((e) => e.data.jobId).filter((id) => !ours.includes(id));
      if (foreign.length) await h.db.update(jobs).set({ dispatchedAt: null }).where(inArray(jobs.id, foreign));
      if (ours.length) await h.db.delete(jobs).where(inArray(jobs.id, ours));
      await h.db.delete(workers).where(eq(workers.instanceId, instanceId));
      await h.close();
    }
  }, 60_000);
});
