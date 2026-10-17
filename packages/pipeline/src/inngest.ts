import { Inngest, type InngestFunction, type TimeStr } from 'inngest';
import { HEAVY } from './heavy';
import { failJob } from './progress';
import { runJanitor } from './janitor';
import { generateAds } from './orchestrate';
import type { PipelineDeps, StepLike } from './types';

export const inngest = new Inngest({ id: 'adforge', isDev: true });
export const EVENTS = { jobRequested: 'adforge/job.requested' } as const;

/** One GPU/CPU-heavy step at a time across ALL heavy functions (env scope + constant key = shared lane). */
export const HEAVY_CONCURRENCY: [{ scope: 'env'; key: string; limit: number }] = [{ scope: 'env', key: '"heavy"', limit: 1 }];

export function createFunctions(deps: PipelineDeps): InngestFunction.Any[] {
  // Invoke-only (no triggers): reached solely through step.invoke from generate-ads.
  const heavyFn = <K extends keyof typeof HEAVY>(task: K, finish: TimeStr) =>
    inngest.createFunction(
      { id: `heavy-${task}`, concurrency: HEAVY_CONCURRENCY, retries: 2, timeouts: { start: '2h', finish } },
      async ({ event, step }) => step.run(task, () => (HEAVY[task] as (d: PipelineDeps, p: unknown) => Promise<unknown>)(deps, event.data)),
    );
  const heavy = { plates: heavyFn('plates', '30m'), broll: heavyFn('broll', '60m'), voice: heavyFn('voice', '30m'), render: heavyFn('render', '30m') };

  const generate = inngest.createFunction(
    { id: 'generate-ads', triggers: [{ event: EVENTS.jobRequested }], retries: 2, concurrency: [{ limit: 2 }], timeouts: { finish: '4h' },
      // Retries exhausted / invoke timed out / load failed: fail the job now instead of waiting for the janitor.
      onFailure: async ({ event, error }) => {
        const jobId = (event.data.event.data as { jobId?: string } | undefined)?.jobId;
        if (jobId) await failJob(deps.db, jobId, error.message);
      },
    },
    async ({ event, step }) => {
      const s: StepLike = {
        run: (id, fn) => step.run(id, fn) as never,
        heavy: (task, id, payload) => step.invoke(id, { function: heavy[task] as InngestFunction.Any, data: payload as never }) as never,
      };
      return generateAds((event.data as { jobId: string }).jobId, s, deps);
    },
  );

  const janitor = inngest.createFunction({ id: 'janitor', triggers: [{ cron: '*/5 * * * *' }], retries: 0, timeouts: { finish: '4m' }, concurrency: [{ limit: 1 }] }, async ({ step }) =>
    step.run('sweep', () => runJanitor(deps)),
  );
  return [generate, heavy.plates, heavy.broll, heavy.voice, heavy.render, janitor];
}
