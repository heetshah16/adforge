import type { Inngest, InngestFunction } from 'inngest';
import type { Db } from '@adforge/db/client';
import { DISPATCH_NUDGE, runDispatcher } from './dispatch';
import { runJanitor } from './janitor';

/**
 * The adforge-web app's functions, served by the web at /api/inngest (Vercel `serve()`); the GPU worker is the separate
 * adforge-gpu app (connect). db + core only, so the web bundle never pulls GPU/LLM provider code. Events are env-wide, so
 * job.requested sent from here triggers adforge-gpu's generate-ads.
 */
export function createLightFunctions(caller: Inngest.Like, getDb: () => Promise<Db>): InngestFunction.Any[] {
  // Inngest.Like (structural): pnpm resolves the web's inngest 4.21.1 in another peer context, so its class type differs from ours; same runtime API.
  const client = caller as Inngest.Any;
  const dispatcher = client.createFunction(
    { id: 'dispatcher', triggers: [{ cron: '* * * * *' }, { event: DISPATCH_NUDGE }], concurrency: [{ limit: 1 }], retries: 2, timeouts: { finish: '2m' } },
    async ({ step }) => step.run('dispatch', async () => runDispatcher(await getDb(), (e) => client.send(e))),
  );
  const janitor = client.createFunction(
    { id: 'janitor', triggers: [{ cron: '*/5 * * * *' }], retries: 0, timeouts: { finish: '4m' }, concurrency: [{ limit: 1 }] },
    async ({ step }) => step.run('sweep', async () => runJanitor(await getDb())),
  );
  return [dispatcher, janitor];
}
