export interface Closable {
  close(cb: () => void): unknown;
  closeIdleConnections(): void;
  closeAllConnections(): void;
}

/** Order: heartbeat (writes offline) -> connect (prod) or server (dev) -> DB. Bounded graceful shutdown: always ends in exit(), and releases the DB lock unless it hangs past the hard deadline. */
export function makeShutdown(o: { server?: Closable; connect?: { close(): Promise<void> }; heartbeat?: { stop(): Promise<void> }; close(): Promise<void>; exit(code: number): void; log?(msg: string, e?: unknown): void; graceMs?: number; hardMs?: number }) {
  const log = o.log ?? ((m, e) => console.error(m, e ?? ''));
  let stopping = false;
  return async (signal: string): Promise<void> => {
    if (stopping) return o.exit(1); // second signal: stop waiting
    stopping = true;
    log(`${signal}: closing`);
    // Ref'd on purpose: a hung close() must not let the process drain and exit 0 with the lock held. process.exit ends a clean shutdown at once.
    setTimeout(() => o.exit(1), o.hardMs ?? 10_000);
    try {
      await o.heartbeat?.stop();
    } catch (e) {
      log('heartbeat stop failed', e);
    }
    try {
      await o.connect?.close(); // in-flight steps finish and flush; bounded by the hard deadline above
      const server = o.server;
      if (server) await new Promise<void>((done) => {
        const grace = setTimeout(() => server.closeAllConnections(), o.graceMs ?? 5_000);
        grace.unref();
        server.close(() => { clearTimeout(grace); done(); });
        server.closeIdleConnections();
      });
    } catch (e) {
      log('server/connect close failed', e);
    } finally {
      try {
        await o.close(); // releases the PGlite lock
      } catch (e) {
        log('db close failed', e);
      } finally {
        o.exit(0);
      }
    }
  };
}
