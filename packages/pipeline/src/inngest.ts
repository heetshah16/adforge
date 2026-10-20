import { Inngest, type GetStepTools, type InngestFunction, type TimeStr } from 'inngest';
import { withStorageOrg } from '@adforge/core/providers/storage-scope';
import { editVariant, exportRevision, failRevision } from './edit';
import { HEAVY } from './heavy';
import { ingestProduct } from './ingest';
import { failJob } from './progress';
import { runJanitor } from './janitor';
import { generateAds } from './orchestrate';
import { orgForEvent } from './record';
import type { PipelineDeps, StepLike } from './types';

export const inngest = new Inngest({ id: 'adforge', isDev: true });
export const EVENTS = { jobRequested: 'adforge/job.requested', productIngest: 'adforge/product.ingest', variantEdit: 'adforge/variant.edit', variantExport: 'adforge/variant.export' } as const;

/** One GPU/CPU-heavy step at a time across ALL heavy functions (env scope + constant key = shared lane). */
export const HEAVY_CONCURRENCY: [{ scope: 'env'; key: string; limit: number }] = [{ scope: 'env', key: '"heavy"', limit: 1 }];

/**
 * Every put runs inside its owning org's storage scope (prod keys are org-prefixed). Inngest calls step callbacks from its
 * own engine loop, outside the handler's async context, so a scope set around the body never reaches them: each handler
 * resolves its org (a missing job/product is non-retriable) and re-enters the scope inside every step callback too.
 */
const scoped = <T>(org: string, fn: () => Promise<T>) => () => withStorageOrg(org, fn);

export function createFunctions(deps: PipelineDeps): InngestFunction.Any[] {
  // Invoke-only (no triggers): reached solely through step.invoke from generate-ads.
  const heavyFn = <K extends keyof typeof HEAVY>(task: K, finish: TimeStr) =>
    inngest.createFunction(
      { id: `heavy-${task}`, concurrency: HEAVY_CONCURRENCY, retries: 2, timeouts: { start: '2h', finish } },
      async ({ event, step }) => {
        const org = await orgForEvent(deps.db, event.data);
        return step.run(task, scoped(org, () => (HEAVY[task] as (d: PipelineDeps, p: unknown) => Promise<unknown>)(deps, event.data)));
      },
    );
  const heavy = { plates: heavyFn('plates', '30m'), plateVision: heavyFn('plateVision', '30m'), broll: heavyFn('broll', '60m'), voice: heavyFn('voice', '30m'), voiceLines: heavyFn('voiceLines', '30m'), plateLines: heavyFn('plateLines', '30m'), render: heavyFn('render', '30m') };

  /** A step facade whose callbacks (and heavy invokes) run in the org's storage scope. */
  const stepsFor = (org: string, step: Pick<GetStepTools<typeof inngest>, 'run' | 'invoke'>): StepLike => ({
    run: (id, fn) => step.run(id, scoped(org, fn)) as never,
    heavy: (task, id, payload) => step.invoke(id, { function: heavy[task] as InngestFunction.Any, data: payload as never }) as never,
  });

  const generate = inngest.createFunction(
    { id: 'generate-ads', triggers: [{ event: EVENTS.jobRequested }], retries: 2, concurrency: [{ limit: 2 }], timeouts: { finish: '4h' },
      // Retries exhausted / invoke timed out / load failed: fail the job now instead of waiting for the janitor.
      onFailure: async ({ event, error }) => {
        const jobId = (event.data.event.data as { jobId?: string } | undefined)?.jobId;
        if (jobId) await failJob(deps.db, jobId, error.message);
      },
    },
    async ({ event, step }) => {
      const org = await orgForEvent(deps.db, event.data);
      return withStorageOrg(org, () => generateAds((event.data as { jobId: string }).jobId, stepsFor(org, step), deps));
    },
  );

  // The org comes from the revision row, never the event; every step callback re-enters it. Idempotent per revision: a revision that is no longer pending is skipped.
  const edit = inngest.createFunction(
    { id: 'variant-edit', triggers: [{ event: EVENTS.variantEdit }], retries: 2, concurrency: [{ limit: 2 }], timeouts: { finish: '2h' },
      onFailure: async ({ event, error }) => {
        const revisionId = (event.data.event.data as { revisionId?: string } | undefined)?.revisionId;
        if (revisionId) await failRevision(deps.db, revisionId, error.message);
      },
    },
    async ({ event, step }) => {
      const org = await orgForEvent(deps.db, event.data);
      return withStorageOrg(org, () => editVariant((event.data as { revisionId: string }).revisionId, stepsFor(org, step), deps));
    },
  );

  const exportFn = inngest.createFunction(
    { id: 'variant-export', triggers: [{ event: EVENTS.variantExport }], retries: 2, concurrency: [{ limit: 2 }, { key: 'event.data.revisionId', limit: 1 }], timeouts: { finish: '1h' } },
    async ({ event, step }) => {
      const org = await orgForEvent(deps.db, event.data);
      return withStorageOrg(org, () => exportRevision((event.data as { revisionId: string }).revisionId, stepsFor(org, step), deps));
    },
  );

  // On the shared heavy lane (cutouts and OCR hold the GPU). Interactive: a user waits on the library entry, so it runs
  // ahead of queued job steps (priority.run advances a run by up to 600 s); B4 sets the priorities across lanes.
  // finish 60m: up to 5 analysis calls (plus repairs) at the 5-min LLM timeout each.
  const ingest = inngest.createFunction(
    { id: 'product-ingest', triggers: [{ event: EVENTS.productIngest }], concurrency: HEAVY_CONCURRENCY, priority: { run: '600' }, retries: 2, timeouts: { start: '2h', finish: '60m' } },
    async ({ event, step, runId, attempt }) => {
      const org = await orgForEvent(deps.db, { productId: (event.data as { productId?: string }).productId }); // never a jobId: the product's org owns its puts
      return withStorageOrg(org, () => ingestProduct(event.data, { runId, attempt, run: (id, fn) => step.run(id, scoped(org, fn)) as never }, deps));
    },
  );

  const janitor = inngest.createFunction({ id: 'janitor', triggers: [{ cron: '*/5 * * * *' }], retries: 0, timeouts: { finish: '4m' }, concurrency: [{ limit: 1 }] }, async ({ step }) =>
    step.run('sweep', () => runJanitor(deps)),
  );
  return [generate, edit, exportFn, heavy.plates, heavy.plateVision, heavy.broll, heavy.voice, heavy.voiceLines, heavy.plateLines, heavy.render, ingest, janitor];
}
