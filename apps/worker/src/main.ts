import './load-env';
import { createServer } from 'node:http';
import { serve } from 'inngest/node';
import { dataDirWarnings, parseEnv } from '@adforge/core/config/env';
import { createFunctions, inngest } from '@adforge/pipeline';
import { buildDeps } from './deps';
import { makeHandler } from './handler';
import { makeRoutes } from './routes';
import { makeProbes } from './heartbeat';
import { assertInngestMode, startRuntime } from './runtime';
import { createLogger, errorSink } from './log';
import { makeShutdown } from './shutdown';

const env = parseEnv(process.env);
assertInngestMode(env.ADFORGE_ENV, inngest.mode);
const logger = createLogger({ dir: env.ADFORGE_DATA_DIR });
const sink = errorSink(logger);
for (const w of dataDirWarnings(env.ADFORGE_DATA_DIR)) logger.warn(w);

const { deps, storage, operator, close } = await buildDeps(env);
const functions = createFunctions(deps);
const base = `http://127.0.0.1:${env.ADFORGE_WORKER_PORT}`;
const makeServer = () => {
  const inngestHandler = serve({ client: inngest, functions });
  const routes = makeRoutes({ deps, storage, operator, sendEvent: async (name, data, id) => { await inngest.send({ name, data: data as Record<string, unknown>, ...(id ? { id } : {}) }); } });
  return createServer(makeHandler({ routes, inngestHandler, env, log: sink }));
};

const { heartbeat, connect, server } = await startRuntime({
  env, db: deps.db, functions, makeServer, probes: makeProbes(env), log: sink,
  onListening: () => logger.info('worker listening', { url: base }),
});
if (connect) logger.info('worker connected to Inngest (no inbound port)', { workerId: env.ADFORGE_WORKER_ID });

const shutdown = makeShutdown({ server, connect, heartbeat, close, log: sink, exit: (c) => process.exit(c) });
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
// Windows: console window closed / Ctrl-Break.
process.on('SIGHUP', () => void shutdown('SIGHUP'));
process.on('SIGBREAK', () => void shutdown('SIGBREAK'));
