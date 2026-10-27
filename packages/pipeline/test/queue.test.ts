import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { openDb, type Db } from '@adforge/db/client';
import { memberships, orgs, projects, users, workers } from '@adforge/db/schema';
import { jobs } from '@adforge/db/schema';
import { seedOperator } from '@adforge/db/seed/seed';
import { queueStatus } from '../src/queue';

let close: (() => Promise<void>) | undefined;
afterEach(async () => { await close?.(); close = undefined; });

type Scope = { orgId: string; userId: string; projectId: string };

async function pglite(): Promise<{ db: Db; op: Scope }> {
  const h = await openDb();
  close = h.close;
  return { db: h.db, op: await seedOperator(h.db) };
}

async function otherScope(db: Db): Promise<Scope> {
  const s = { orgId: randomUUID(), userId: randomUUID(), projectId: randomUUID() };
  await db.insert(orgs).values({ id: s.orgId, name: `q-${s.orgId}` });
  await db.insert(users).values({ id: s.userId, email: `${s.userId}@queue.test` });
  await db.insert(memberships).values({ orgId: s.orgId, userId: s.userId, role: 'owner' });
  await db.insert(projects).values({ id: s.projectId, orgId: s.orgId, userId: s.userId, name: 'Default' });
  return s;
}

/** A fresh heartbeat `ageSec` old, on the SQL clock. */
const beat = (db: Db, ageSec: number) =>
  db.insert(workers).values({ instanceId: `q-${randomUUID()}`, status: 'online', lastSeen: sql`now() - ${ageSec}::int * interval '1 second'` });

/** A completed job of `durationSec` seconds (dispatched at creation, completed `durationSec` later). */
async function completed(db: Db, scope: Scope, opts: { language?: string; broll?: boolean; durationSec: number; ageSec?: number; status?: 'completed' | 'failed' }) {
  const age = opts.ageSec ?? opts.durationSec + 600;
  const [j] = await db.insert(jobs).values({
    ...scope,
    status: opts.status ?? 'completed',
    inputSpec: { language: opts.language ?? 'en', broll: opts.broll ?? false },
    createdAt: sql`now() - ${age}::int * interval '1 second'`,
    dispatchedAt: sql`now() - ${age}::int * interval '1 second'`,
    completedAt: sql`now() - ${age - opts.durationSec}::int * interval '1 second'`,
  }).returning({ id: jobs.id });
  return j!.id;
}

/** A queued job created `ageSec` ago (default: just now). */
async function queued(db: Db, scope: Scope, opts: { ageSec?: number; language?: string; broll?: boolean } = {}) {
  const [j] = await db.insert(jobs).values({
    ...scope,
    status: 'queued',
    inputSpec: { language: opts.language ?? 'en', broll: opts.broll ?? false },
    ...(opts.ageSec !== undefined ? { createdAt: sql`now() - ${opts.ageSec}::int * interval '1 second'` } : {}),
  }).returning({ id: jobs.id });
  return j!.id;
}

/** A running job created `ageSec` ago (default: just now), dispatched `dispatchedAgeSec` ago (default: never — null). */
async function running(db: Db, scope: Scope, opts: { ageSec?: number; dispatchedAgeSec?: number; inputSpec?: Record<string, unknown> } = {}) {
  const [j] = await db.insert(jobs).values({
    ...scope,
    status: 'running',
    inputSpec: opts.inputSpec ?? { language: 'en', broll: false },
    ...(opts.ageSec !== undefined ? { createdAt: sql`now() - ${opts.ageSec}::int * interval '1 second'` } : {}),
    ...(opts.dispatchedAgeSec !== undefined ? { dispatchedAt: sql`now() - ${opts.dispatchedAgeSec}::int * interval '1 second'` } : {}),
  }).returning({ id: jobs.id });
  return j!.id;
}

/**
 * C1: postgres-js (drizzle-orm/postgres-js) rejects JS Date params with ERR_INVALID_ARG_TYPE;
 * PGlite tolerates them, so without this wrapper the suite would pass while prod 500s.
 * Wraps the session so any prepared query carrying a Date param throws.
 */
function rejectDateParams(db: Db): void {
  const session = (db as unknown as {
    session: { prepareQuery: (query: { params?: unknown[] }, ...rest: never[]) => unknown };
  }).session;
  const orig = session.prepareQuery.bind(session);
  session.prepareQuery = ((query: { params?: unknown[] }, ...rest: never[]) => {
    for (const p of query?.params ?? []) {
      if (p instanceof Date) throw new Error('queueStatus interpolated a JS Date into SQL — keep timestamps in SQL');
    }
    return orig(query, ...rest);
  }) as typeof session.prepareQuery;
}

describe('queueStatus', () => {
  it('null for a completed job, a failed job, and an unknown id', async () => {
    const { db, op } = await pglite();
    await beat(db, 5);
    const done = await completed(db, op, { durationSec: 600 });
    const [failed] = await db.insert(jobs).values({ ...op, status: 'failed', inputSpec: {} }).returning({ id: jobs.id });
    expect(await queueStatus(db, done)).toBeNull();
    expect(await queueStatus(db, failed!.id)).toBeNull();
    expect(await queueStatus(db, randomUUID())).toBeNull();
  });

  it('position counts queued and running jobs of other orgs created before this one', async () => {
    const { db, op } = await pglite();
    await beat(db, 5);
    const other = await otherScope(db);
    await queued(db, other, { ageSec: 300 }); // another org, ahead
    await queued(db, op, { ageSec: 200 }); // same org, ahead
    const target = await queued(db, op);
    await db.insert(jobs).values({ ...other, status: 'running', inputSpec: {} }); // running now: behind the target, not ahead
    await queued(db, op, {}); // created after: does not move the target back
    const q = await queueStatus(db, target);
    expect(q).toMatchObject({ position: 3 });
  });

  it('ETA from seeded completed durations with the same (language, broll)', async () => {
    const { db, op } = await pglite();
    await beat(db, 5);
    await completed(db, op, { language: 'en', broll: false, durationSec: 600 });
    await completed(db, op, { language: 'en', broll: false, durationSec: 1200 });
    await completed(db, op, { language: 'hi', broll: true, durationSec: 3600 }); // other group: must not leak in
    await queued(db, op, { ageSec: 300 }); // one job ahead: ETA is time until this job starts
    const target = await queued(db, op, { language: 'en', broll: false });
    // ahead = 1, remaining = 0 (queued): p50 = 900, p90 = 600 + 0.9 * 600 = 1140
    expect(await queueStatus(db, target)).toEqual({ position: 2, etaRange: [900, 1140] });
  });

  it('ETA splits by language and b-roll', async () => {
    const { db, op } = await pglite();
    await beat(db, 5);
    await completed(db, op, { language: 'en', broll: false, durationSec: 600 });
    await completed(db, op, { language: 'hi', broll: true, durationSec: 1800 });
    await queued(db, op, { ageSec: 300 });
    const hi = await queued(db, op, { language: 'hi', broll: true });
    const en = await queued(db, op, { language: 'en', broll: false });
    expect(await queueStatus(db, hi)).toEqual({ position: 2, etaRange: [1800, 1800] });
    expect(await queueStatus(db, en)).toEqual({ position: 3, etaRange: [1200, 1200] });
  });

  it('falls back to all completed jobs, then to the 900 s default', async () => {
    const { db, op } = await pglite();
    await beat(db, 5);
    await completed(db, op, { language: 'hi', broll: true, durationSec: 1200 });
    await queued(db, op, { ageSec: 300 });
    const fr = await queued(db, op, { language: 'fr', broll: false }); // no (fr, false) rows: all-completed fallback
    expect(await queueStatus(db, fr)).toEqual({ position: 2, etaRange: [1200, 1200] });
    await db.delete(jobs);
    await queued(db, op, { ageSec: 300 });
    const fresh = await queued(db, op);
    expect(await queueStatus(db, fresh)).toEqual({ position: 2, etaRange: [900, 900] });
  });

  it('ignores failed jobs and completions older than 30 days in the same-group percentile', async () => {
    const { db, op } = await pglite();
    await beat(db, 5);
    await completed(db, op, { durationSec: 600 });
    await completed(db, op, { durationSec: 99999, status: 'failed' });
    await completed(db, op, { durationSec: 99999, ageSec: 33 * 24 * 3600 }); // completed ~31.8 days ago: outside the 30-day window
    await queued(db, op, { ageSec: 300 });
    const target = await queued(db, op);
    expect(await queueStatus(db, target)).toEqual({ position: 2, etaRange: [600, 600] });
  });

  it('C1: never interpolates a JS Date into SQL (postgres-js rejects Date params)', async () => {
    const { db, op } = await pglite();
    await beat(db, 5);
    await completed(db, op, { durationSec: 600 });
    await completed(db, op, { durationSec: 1200 }); // p50 = 900, p90 = 1140
    await running(db, op, { ageSec: 300, dispatchedAgeSec: 100 }); // ahead: ~100 s elapsed
    await queued(db, op, { ageSec: 200 }); // ahead
    const target = await queued(db, op);
    rejectDateParams(db);
    // queuedAhead = 1, one running job ahead with ~800 s / ~1040 s left
    expect(await queueStatus(db, target)).toEqual({ position: 3, etaRange: [1700, 2180] });
  });

  it('a queued job ETA includes the running jobs ahead: queuedAhead x p + SUM max(0, p - elapsed)', async () => {
    const { db, op } = await pglite();
    await beat(db, 5);
    await completed(db, op, { durationSec: 600 });
    await completed(db, op, { durationSec: 1200 }); // p50 = 900, p90 = 1140
    await running(db, op, { ageSec: 300, dispatchedAgeSec: 100 }); // ahead: ~100 s elapsed
    await queued(db, op, { ageSec: 200 }); // ahead
    const target = await queued(db, op);
    // 1 x 900 + (900 - ~100) = ~1700; 1 x 1140 + (1140 - ~100) = ~2180
    expect(await queueStatus(db, target)).toEqual({ position: 3, etaRange: [1700, 2180] });
  });

  it('a running job reports its own remaining range [max(0, p50 - e), max(0, p90 - e)] and ignores jobs ahead', async () => {
    const { db, op } = await pglite();
    await beat(db, 5);
    await completed(db, op, { durationSec: 600 });
    await completed(db, op, { durationSec: 1200 }); // p50 = 900, p90 = 1140
    await queued(db, op, { ageSec: 300 }); // ahead: moves position, not a running job's ETA
    await running(db, op, { ageSec: 200, dispatchedAgeSec: 100 }); // ahead, ~100 s elapsed: ignored
    const run = await running(db, op, { dispatchedAgeSec: 100 });
    expect(await queueStatus(db, run)).toEqual({ position: 3, etaRange: [800, 1040] });
    await db.update(jobs).set({ dispatchedAt: sql`now() - 1000::int * interval '1 second'` }).where(eq(jobs.id, run));
    expect(await queueStatus(db, run)).toEqual({ position: 3, etaRange: [0, 140] });
  });

  it('a running job with null dispatched_at counts elapsed as 0 (full p50/p90)', async () => {
    const { db, op } = await pglite();
    await beat(db, 5);
    await completed(db, op, { durationSec: 600 });
    await completed(db, op, { durationSec: 1200 }); // p50 = 900, p90 = 1140
    const run = await running(db, op); // dispatchedAt stays null
    expect(await queueStatus(db, run)).toEqual({ position: 1, etaRange: [900, 1140] });
  });

  it('inputSpec without language/broll groups with its own kind and ignores fully-specified jobs', async () => {
    const { db, op } = await pglite();
    await beat(db, 5);
    await completed(db, op, { durationSec: 600 }); // (en, false): must not leak into the (null, null) group
    await completed(db, op, { language: 'en', broll: true, durationSec: 3600 }); // other group
    await db.insert(jobs).values({
      ...op, status: 'completed', inputSpec: {},
      createdAt: sql`now() - 1800::int * interval '1 second'`,
      dispatchedAt: sql`now() - 1800::int * interval '1 second'`,
      completedAt: sql`now() - 1200::int * interval '1 second'`, // duration 600
    });
    await db.insert(jobs).values({
      ...op, status: 'completed', inputSpec: {},
      createdAt: sql`now() - 2400::int * interval '1 second'`,
      dispatchedAt: sql`now() - 2400::int * interval '1 second'`,
      completedAt: sql`now() - 1200::int * interval '1 second'`, // duration 1200
    });
    await queued(db, op, { ageSec: 300 }); // ahead: global position, but its group does not matter here
    const [t] = await db.insert(jobs).values({ ...op, status: 'queued', inputSpec: {} }).returning({ id: jobs.id });
    // (null, null) group: p50 = 900, p90 = 1140
    expect(await queueStatus(db, t!.id)).toEqual({ position: 2, etaRange: [900, 1140] });
  });

  it('inputSpec with only language falls back to the (language, null) group', async () => {
    const { db, op } = await pglite();
    await beat(db, 5);
    await completed(db, op, { durationSec: 600 }); // (en, false): must not leak into the (en, null) group
    await db.insert(jobs).values({
      ...op, status: 'completed', inputSpec: { language: 'en' },
      createdAt: sql`now() - 1800::int * interval '1 second'`,
      dispatchedAt: sql`now() - 1800::int * interval '1 second'`,
      completedAt: sql`now() - 1300::int * interval '1 second'`, // duration 500
    });
    await queued(db, op, { ageSec: 300 }); // ahead
    const [t] = await db.insert(jobs).values({ ...op, status: 'queued', inputSpec: { language: 'en' } }).returning({ id: jobs.id });
    // (en, null) group: only the 500 s completion; position counts the queued job ahead
    expect(await queueStatus(db, t!.id)).toEqual({ position: 2, etaRange: [500, 500] });
  });

  it('excludes non-positive durations from the percentiles', async () => {
    const { db, op } = await pglite();
    await beat(db, 5);
    await completed(db, op, { durationSec: 600 });
    await db.insert(jobs).values({ // zero duration: completed_at = dispatched_at
      ...op, status: 'completed', inputSpec: { language: 'en', broll: false },
      createdAt: sql`now() - 3600::int * interval '1 second'`,
      dispatchedAt: sql`now() - 3600::int * interval '1 second'`,
      completedAt: sql`now() - 3600::int * interval '1 second'`,
    });
    await db.insert(jobs).values({ // negative duration: completed_at < dispatched_at
      ...op, status: 'completed', inputSpec: { language: 'en', broll: false },
      createdAt: sql`now() - 3700::int * interval '1 second'`,
      dispatchedAt: sql`now() - 3600::int * interval '1 second'`,
      completedAt: sql`now() - 3700::int * interval '1 second'`,
    });
    await db.insert(jobs).values({ // undispatched zero: completed_at = created_at, dispatched_at null
      ...op, status: 'completed', inputSpec: { language: 'en', broll: false },
      createdAt: sql`now() - 3600::int * interval '1 second'`,
      completedAt: sql`now() - 3600::int * interval '1 second'`,
    });
    await queued(db, op, { ageSec: 300 }); // ahead
    const target = await queued(db, op);
    expect(await queueStatus(db, target)).toEqual({ position: 2, etaRange: [600, 600] });
  });

  it('paused when the heartbeat is stale, and when there is no worker at all', async () => {
    const { db, op } = await pglite();
    const target = await queued(db, op);
    expect(await queueStatus(db, target)).toEqual({ position: 1, etaRange: 'paused' }); // no worker row
    await beat(db, 180); // 3 min old
    expect(await queueStatus(db, target)).toEqual({ position: 1, etaRange: 'paused' });
    await db.delete(workers);
    await beat(db, 5);
    const q = await queueStatus(db, target);
    expect(q?.etaRange).not.toBe('paused');
  });
});
