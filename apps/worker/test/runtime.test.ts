import { describe, expect, it, vi } from 'vitest';
import { openDb } from '@adforge/db/client';
import { workers } from '@adforge/db/schema';
import type { Probes } from '../src/heartbeat';
import { assertInngestMode, startRuntime, type ListenableServer } from '../src/runtime';

const ok: Probes = { gpu: async () => ({ gpu: 'RTX 4090', vramFreeMb: 20000 }), services: async () => ({ comfyui: true, voice: true, qwen: true, vision: true }) };
const withDb = async (f: (h: Awaited<ReturnType<typeof openDb>>) => Promise<void>) => { const h = await openDb(); try { await f(h); } finally { await h.close(); } };

const server = () => { const s = { listen: vi.fn(), close: vi.fn(), closeIdleConnections: vi.fn(), closeAllConnections: vi.fn(), requestTimeout: 0 }; return s as unknown as ListenableServer & { listen: ReturnType<typeof vi.fn> }; };

describe('startRuntime', () => {

  it('prod connects outbound and never builds or listens on a server', () => withDb(async (h) => {
    const makeServer = vi.fn(server);
    const connectFn = vi.fn(async () => ({ close: async () => {}, state: 'ACTIVE' })) as never;
    const r = await startRuntime({ env: { ADFORGE_ENV: 'prod', ADFORGE_WORKER_ID: 'gpu-1', ADFORGE_WORKER_PORT: 3001 }, db: h.db, probes: ok, functions: [], makeServer, connectFn });
    expect(makeServer).not.toHaveBeenCalled();
    expect(r.server).toBeUndefined();
    expect(connectFn).toHaveBeenCalledWith(expect.objectContaining({ instanceId: 'gpu-1', maxWorkerConcurrency: 1, handleShutdownSignals: [] }));
    await r.heartbeat.stop();
  }));

  it('prod: the heartbeat is gated on the connection state (isLive = connect.isActive)', () => withDb(async (h) => {
    const conn = { close: async () => {}, state: 'CONNECTING' };
    const connectFn = vi.fn(async () => conn) as never;
    const env = { ADFORGE_ENV: 'prod' as const, ADFORGE_WORKER_ID: 'gpu-1', ADFORGE_WORKER_PORT: 3001 };
    const down = await startRuntime({ env, db: h.db, probes: ok, functions: [], makeServer: server, connectFn });
    expect(down.connect!.isActive()).toBe(false);
    await down.heartbeat.stop();
    expect(await h.db.select().from(workers)).toEqual([]); // not ACTIVE: no online write
    conn.state = 'ACTIVE';
    expect(down.connect!.isActive()).toBe(true);
    const up = await startRuntime({ env, db: h.db, probes: ok, functions: [], makeServer: server, connectFn });
    await up.heartbeat.stop();
    expect(await h.db.select().from(workers)).toHaveLength(1);
  }));

  it('prod: a failed connect leaves no heartbeat row', () => withDb(async (h) => {
    const connectFn = vi.fn(async () => { throw new Error('gateway down'); }) as never;
    await expect(startRuntime({ env: { ADFORGE_ENV: 'prod', ADFORGE_WORKER_ID: 'gpu-1', ADFORGE_WORKER_PORT: 3001 }, db: h.db, probes: ok, functions: [], makeServer: server, connectFn })).rejects.toThrow('gateway down');
    expect(await h.db.select().from(workers)).toEqual([]);
  }));

  it('dev listens on 127.0.0.1 only and does not connect', () => withDb(async (h) => {
    const s = server();
    const connectFn = vi.fn() as never;
    const r = await startRuntime({ env: { ADFORGE_ENV: 'dev', ADFORGE_WORKER_PORT: 3001 }, db: h.db, probes: ok, functions: [], makeServer: () => s, connectFn });
    expect(s.listen).toHaveBeenCalledWith(3001, '127.0.0.1', expect.any(Function));
    expect(connectFn).not.toHaveBeenCalled();
    await r.heartbeat.stop();
  }));
});

describe('assertInngestMode', () => {
  it('accepts matching pairs and refuses a mismatch', () => {
    expect(() => assertInngestMode('prod', 'cloud')).not.toThrow();
    expect(() => assertInngestMode('dev', 'dev')).not.toThrow();
    expect(() => assertInngestMode('prod', 'dev')).toThrow(/ADFORGE_ENV=prod needs cloud/);
    expect(() => assertInngestMode('dev', 'cloud')).toThrow(/needs dev/);
  });
});
