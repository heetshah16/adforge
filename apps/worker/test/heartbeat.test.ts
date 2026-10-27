import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb } from '@adforge/db/client';
import { sql } from 'drizzle-orm';
import { workers } from '@adforge/db/schema';
import { lastSeenOnline, startHeartbeat, type Probes } from '../src/heartbeat';

let h: Awaited<ReturnType<typeof openDb>>;
beforeEach(async () => { h = await openDb(); vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] }); });
afterEach(async () => { vi.useRealTimers(); await h.close(); });

const ok: Probes = { gpu: async () => ({ gpu: 'RTX 4090', vramFreeMb: 20000 }), services: async () => ({ comfyui: true, voice: true, qwen: true, vision: true }) };
const row = async () => (await h.db.select().from(workers))[0]!;

describe('startHeartbeat', () => {
  it('upserts a row at start and every interval; last_seen advances', async () => {
    const hb = startHeartbeat({ db: h.db, instanceId: 'gpu-1', probes: ok, intervalMs: 30_000, log: () => {} });
    await vi.advanceTimersByTimeAsync(0);
    const first = await row();
    expect(first).toMatchObject({ status: 'online', gpu: 'RTX 4090', vramFreeMb: 20000, services: { comfyui: true, voice: true, qwen: true, vision: true } });
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(0);
    const second = await row();
    expect(second.lastSeen.getTime()).toBeGreaterThan(first.lastSeen.getTime());
    expect(await h.db.select().from(workers)).toHaveLength(1);
    await hb.stop();
  });

  it('I3: online_since is set on the first write, kept while the row stays fresh and online, reset after a stale gap or an offline row', async () => {
    const hb = startHeartbeat({ db: h.db, instanceId: 'gpu-1', probes: ok, intervalMs: 30_000, log: () => {} });
    const beat = async () => { await vi.advanceTimersByTimeAsync(30_000); await vi.advanceTimersByTimeAsync(0); };
    // SQL clock (Date is faked here): is online_since within the last minute?
    const recent = async () => ((await h.db.select({ r: sql<boolean>`${workers.onlineSince} > now() - interval '1 minute'` }).from(workers))[0]!.r);
    await vi.advanceTimersByTimeAsync(0);
    expect(await recent()).toBe(true);
    await h.db.update(workers).set({ onlineSince: sql`now() - interval '3 hours'` });
    await beat();
    expect(await recent()).toBe(false); // continuous: kept
    await h.db.update(workers).set({ lastSeen: sql`now() - interval '10 minutes'` });
    await beat();
    expect(await recent()).toBe(true); // a stale gap (machine slept): reset
    await h.db.update(workers).set({ onlineSince: sql`now() - interval '3 hours'`, status: 'offline' });
    await beat();
    expect(await recent()).toBe(true); // after a clean stop: reset
    await hb.stop();
  });

  it('a failing probe marks services false and never throws', async () => {
    const bad: Probes = { gpu: async () => { throw new Error('no smi'); }, services: async () => ({ comfyui: true, voice: false }) };
    const hb = startHeartbeat({ db: h.db, instanceId: 'gpu-1', probes: bad, log: () => { throw new Error('should not log'); } });
    await vi.advanceTimersByTimeAsync(0);
    expect(await row()).toMatchObject({ status: 'online', gpu: null, vramFreeMb: null, services: { comfyui: true, voice: false, qwen: false, vision: false } });
    const worse: Probes = { gpu: bad.gpu, services: async () => { throw new Error('boom'); } };
    await hb.stop();
    const hb2 = startHeartbeat({ db: h.db, instanceId: 'gpu-2', probes: worse, log: () => {} });
    await vi.advanceTimersByTimeAsync(0);
    const r = (await h.db.select().from(workers)).find((w) => w.instanceId === 'gpu-2')!;
    expect(r.services).toEqual({ comfyui: false, voice: false, qwen: false, vision: false });
    await hb2.stop();
  });

  it('stop writes offline once and stops the interval', async () => {
    const hb = startHeartbeat({ db: h.db, instanceId: 'gpu-1', probes: ok, log: () => {} });
    await vi.advanceTimersByTimeAsync(0);
    await hb.stop();
    await hb.stop();
    expect((await row()).status).toBe('offline');
    const seen = (await row()).lastSeen;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(await row()).toMatchObject({ status: 'offline', lastSeen: seen });
  });

  it('a clean stop does not bump last_seen and lastSeenOnline ignores the offline row', async () => {
    const hb = startHeartbeat({ db: h.db, instanceId: 'gpu-1', probes: ok, log: () => {} });
    await vi.advanceTimersByTimeAsync(0);
    const online = await row();
    expect((await lastSeenOnline(h.db))?.getTime()).toBe(online.lastSeen.getTime());
    await vi.advanceTimersByTimeAsync(5_000);
    await hb.stop();
    expect((await row()).lastSeen.getTime()).toBe(online.lastSeen.getTime());
    expect(await lastSeenOnline(h.db)).toBeNull();
  });

  it('stop returns within ~1 s even when the offline write hangs', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
    const hang = new Promise(() => {});
    const db = { insert: () => ({ values: () => ({ onConflictDoUpdate: async () => {} }) }), update: () => ({ set: () => ({ where: () => hang }) }) } as never;
    const hb = startHeartbeat({ db, instanceId: 'gpu-1', probes: ok, log: () => {} });
    await vi.advanceTimersByTimeAsync(0);
    let done = false;
    void hb.stop().then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
  });
});
