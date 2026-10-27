import { createServer } from 'node:http';
import { join } from 'node:path';
import { serve } from 'inngest/node';
import { REPO_ROOT, dataDirWarnings, parseEnv } from '@adforge/core/config/env';
import { createFunctions, inngest } from '@adforge/pipeline';
import { buildDeps } from './deps';
import { makeHandler } from './handler';
import { makeRoutes } from './routes';
import { makeProbes } from './heartbeat';
import { startRuntime } from './runtime';
import { makeShutdown } from './shutdown';

try {
  process.loadEnvFile(join(REPO_ROOT, '.env'));
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
}
const env = parseEnv(process.env);
for (const w of dataDirWarnings(env.ADFORGE_DATA_DIR)) console.warn(`WARN ${w}`);

const { deps, storage, operator, close } = await buildDeps(env);
const functions = createFunctions(deps);
const base = `http://127.0.0.1:${env.ADFORGE_WORKER_PORT}`;
const makeServer = () => {
  const inngestHandler = serve({ client: inngest, functions });
  const routes = makeRoutes({ deps, storage, operator, sendEvent: async (name, data, id) => { await inngest.send({ name, data: data as Record<string, unknown>, ...(id ? { id } : {}) }); } });
  return createServer(makeHandler({ routes, inngestHandler, env }));
};

const { heartbeat, connect, server } = await startRuntime({
  env, db: deps.db, functions, makeServer, probes: makeProbes(env),
  onListening: () => console.log(`worker on ${base}`),
});
if (connect) console.log(`worker connected to Inngest as ${env.ADFORGE_WORKER_ID} (no inbound port)`);

const shutdown = makeShutdown({ server, connect, heartbeat, close, exit: (c) => process.exit(c) });
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
// Windows: console window closed / Ctrl-Break.
process.on('SIGHUP', () => void shutdown('SIGHUP'));
process.on('SIGBREAK', () => void shutdown('SIGBREAK'));
