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

  it('a running job gets remaining = max(0, p50 − elapsed since dispatched_at), on the SQL clock', async () => {
    const { db, op } = await pglite();
    await beat(db, 5);
    await completed(db, op, { durationSec: 600 });
    const [run] = await db.insert(jobs).values({
      ...op, status: 'running', inputSpec: { language: 'en', broll: false },
      dispatchedAt: sql`now() - 100::int * interval '1 second'`,
    }).returning({ id: jobs.id });
    expect(await queueStatus(db, run!.id)).toEqual({ position: 1, etaRange: [500, 500] });
    await db.update(jobs).set({ dispatchedAt: sql`now() - 1000::int * interval '1 second'` }).where(eq(jobs.id, run!.id));
    expect(await queueStatus(db, run!.id)).toEqual({ position: 1, etaRange: [0, 0] });
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
