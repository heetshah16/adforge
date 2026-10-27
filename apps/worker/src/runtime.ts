import type { Db } from '@adforge/db/client';
import type { Env } from '@adforge/core/config/env';
import { startConnect } from './connect';
import { startHeartbeat, type Probes } from './heartbeat';
import type { Closable } from './shutdown';

type ConnectFns = Parameters<typeof startConnect>[0];
export type ListenableServer = Closable & { listen(port: number, host: string, cb: () => void): unknown; requestTimeout: number };

/**
 * Prod: outbound-only inngest/connect, and makeServer is never called, so nothing can listen.
 * Dev: the 127.0.0.1 HTTP API (serve() + routes). Both: the heartbeat, so the dev UI's GPU badge works.
 */
export async function startRuntime(o: {
  env: Pick<Env, 'ADFORGE_ENV' | 'ADFORGE_WORKER_ID' | 'ADFORGE_WORKER_PORT'>;
  db: Db; probes: Probes; functions: ConnectFns['functions'];
  makeServer(): ListenableServer;
  connectFn?: ConnectFns['connectFn'];
  onListening?(): void;
}) {
  const instanceId = o.env.ADFORGE_WORKER_ID ?? 'dev-local';
  if (o.env.ADFORGE_ENV === 'prod') {
    // Heartbeat only after connect resolves: a failed connect must not leave a fresh 'online' row.
    const connect = await startConnect({ functions: o.functions, instanceId, connectFn: o.connectFn });
    return { heartbeat: startHeartbeat({ db: o.db, instanceId, probes: o.probes }), connect, server: undefined };
  }
  const heartbeat = startHeartbeat({ db: o.db, instanceId, probes: o.probes });
  const server = o.makeServer();
  server.requestTimeout = 120_000; // bounds request *receipt* (slow uploads), not handler run time
  server.listen(o.env.ADFORGE_WORKER_PORT, '127.0.0.1', () => o.onListening?.());
  return { heartbeat, connect: undefined, server };
}

/** The Inngest client is built at import time from process.env; refuse to boot if it disagrees with the parsed env (e.g. ADFORGE_ENV=prod reached only a later-loaded .env). */
export function assertInngestMode(adforgeEnv: 'dev' | 'prod', mode: string): void {
  const want = adforgeEnv === 'prod' ? 'cloud' : 'dev';
  if (mode !== want) throw new Error(`Inngest client is in ${mode} mode but ADFORGE_ENV=${adforgeEnv} needs ${want}: ADFORGE_ENV must be set before @adforge/pipeline is imported`);
}
