import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeShutdown } from '../src/shutdown';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function setup(close: () => Promise<void>, serverClosesImmediately = true) {
  const order: string[] = [];
  const exits: number[] = [];
  const server = {
    close: (cb: () => void) => { order.push('server.close'); if (serverClosesImmediately) cb(); else (server as { cb?: () => void }).cb = cb; },
    closeIdleConnections: () => { order.push('idle'); },
    closeAllConnections: () => { order.push('all'); },
  };
  const shutdown = makeShutdown({ server, close: async () => { order.push('db.close'); await close(); }, exit: (c) => { exits.push(c); }, log: () => {} });
  return { order, exits, shutdown, server };
}

describe('makeShutdown', () => {
  it('closes the db after the server and exits 0', async () => {
    const s = setup(async () => {});
    await s.shutdown('SIGINT');
    expect(s.order).toEqual(['server.close', 'idle', 'db.close']);
    expect(s.exits).toEqual([0]);
  });

  it('still exits 0 when db close throws', async () => {
    const s = setup(async () => { throw new Error('boom'); });
    await s.shutdown('SIGTERM');
    expect(s.exits).toEqual([0]);
  });

  it('hard timeout exits 1 when db close hangs', async () => {
    const s = setup(() => new Promise(() => {}));
    void s.shutdown('SIGINT');
    await vi.advanceTimersByTimeAsync(9_999);
    expect(s.exits).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.exits).toEqual([1]);
  });

  it('forces connections closed after the grace period, then closes the db once the server is done', async () => {
    const s = setup(async () => {}, false);
    const p = s.shutdown('SIGINT');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(s.order).toContain('all');
    expect(s.order).not.toContain('db.close');
    (s.server as unknown as { cb: () => void }).cb();
    await p;
    expect(s.exits).toEqual([0]);
  });

  it('a second signal exits 1 immediately', async () => {
    const s = setup(() => new Promise(() => {}));
    void s.shutdown('SIGINT');
    await s.shutdown('SIGINT');
    expect(s.exits).toEqual([1]);
  });
});
