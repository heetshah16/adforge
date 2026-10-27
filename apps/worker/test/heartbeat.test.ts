import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb } from '@adforge/db/client';
import { workers } from '@adforge/db/schema';
import { startHeartbeat, type Probes } from '../src/heartbeat';
import { startRuntime, type ListenableServer } from '../src/runtime';

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
    expect(second.lastSeen.getTime() - first.lastSeen.getTime()).toBe(30_000);
    expect(await h.db.select().from(workers)).toHaveLength(1);
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
});

describe('startRuntime', () => {
  const server = () => { const s = { listen: vi.fn(), close: vi.fn(), closeIdleConnections: vi.fn(), closeAllConnections: vi.fn(), requestTimeout: 0 }; return s as unknown as ListenableServer & { listen: ReturnType<typeof vi.fn> }; };

  it('prod connects outbound and never builds or listens on a server', async () => {
    const makeServer = vi.fn(server);
    const connectFn = vi.fn(async () => ({ close: async () => {} })) as never;
    const r = await startRuntime({ env: { ADFORGE_ENV: 'prod', ADFORGE_WORKER_ID: 'gpu-1', ADFORGE_WORKER_PORT: 3001 }, db: h.db, probes: ok, functions: [], makeServer, connectFn });
    expect(makeServer).not.toHaveBeenCalled();
    expect(r.server).toBeUndefined();
    expect(connectFn).toHaveBeenCalledWith(expect.objectContaining({ instanceId: 'gpu-1', maxWorkerConcurrency: 1, handleShutdownSignals: [] }));
    await r.heartbeat.stop();
  });

  it('dev listens on 127.0.0.1 only and does not connect', async () => {
    const s = server();
    const connectFn = vi.fn() as never;
    const r = await startRuntime({ env: { ADFORGE_ENV: 'dev', ADFORGE_WORKER_PORT: 3001 }, db: h.db, probes: ok, functions: [], makeServer: () => s, connectFn });
    expect(s.listen).toHaveBeenCalledWith(3001, '127.0.0.1', expect.any(Function));
    expect(connectFn).not.toHaveBeenCalled();
    await r.heartbeat.stop();
  });
});
