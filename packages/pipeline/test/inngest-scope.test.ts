import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InngestFunction } from 'inngest';
import { storageOrg } from '@adforge/core/providers/storage-scope';
import { jobs, orgs, products, projects, variantRevisions, variants } from '@adforge/db/schema';
import { HEAVY } from '../src/heavy';
import { createFunctions, inngest } from '../src/inngest';
import { jobRow, makeDeps } from './fakes';

// The bodies are replaced by probes that record storageOrg() in the body and inside a step.run callback.
const seen = vi.hoisted(() => [] as [string, string | undefined][]);
vi.mock('../src/orchestrate', () => ({
  generateAds: async (_jobId: string, s: { run: (id: string, fn: () => Promise<unknown>) => Promise<unknown> }) => {
    seen.push(['generate-ads body', storageOrg()]);
    return s.run('probe', async () => { seen.push(['generate-ads step', storageOrg()]); return null; });
  },
}));
vi.mock('../src/edit', () => {
  type S = { run: (id: string, fn: () => Promise<unknown>) => Promise<unknown> };
  const probe = (name: string) => async (_id: string, s: S) => {
    seen.push([`${name} body`, storageOrg()]);
    return s.run('probe', async () => { seen.push([`${name} step`, storageOrg()]); return null; });
  };
  return { failRevision: async () => undefined, editVariant: probe('variant-edit'), exportRevision: probe('variant-export') };
});
vi.mock('../src/ingest', () => ({
  ingestProduct: async (_data: unknown, s: { run: (id: string, fn: () => Promise<unknown>) => Promise<unknown> }) => {
    seen.push(['product-ingest body', storageOrg()]);
    return s.run('probe', async () => { seen.push(['product-ingest step', storageOrg()]); return null; });
  },
}));

/**
 * Runs one request through Inngest's real execution engine (what `serve` does per HTTP call): the body until the first
 * new step, then that step. The real engine matters — it runs step callbacks from its own loop, outside the handler's
 * async context, so a scope set only around the body would be invisible to them. createExecution is protected API
 * (what @inngest/test drives); inngest is pinned exactly.
 */
type Outcome = { type: string; retriable?: boolean | string; error?: unknown };
function execute(fn: InngestFunction.Any, data: Record<string, unknown>): Promise<Outcome> {
  // The function's own trigger (the engine validates it); invoke-only heavy functions receive Inngest's invoke event.
  const name = (fn.opts.triggers as { event?: string }[] | undefined)?.[0]?.event ?? 'inngest/function.invoked';
  const event = { name, data };
  const exec = (fn as unknown as { createExecution(o: unknown): { start(): Promise<Outcome> } }).createExecution({
    partialOptions: { client: inngest, data: { event, events: [event], runId: 'run-1', attempt: 0 }, runId: 'run-1', stepState: {}, stepCompletionOrder: [], stepMode: 'async', reqArgs: [], headers: {} },
  });
  return exec.start();
}

let close: (() => Promise<void>) | undefined;
afterEach(async () => { await close?.(); close = undefined; seen.length = 0; vi.restoreAllMocks(); });

/** A second org (not the Operator default) owning one job and one product. */
async function setup() {
  const m = await makeDeps(); close = m.close;
  const orgId = randomUUID();
  await m.deps.db.insert(orgs).values({ id: orgId, name: 'Tenant A' });
  const [p] = await m.deps.db.insert(projects).values({ orgId, userId: m.op.userId, name: 'A' }).returning();
  const [j] = await m.deps.db.insert(jobs).values({ orgId, projectId: p!.id, userId: m.op.userId, inputSpec: {} }).returning();
  const [pr] = await m.deps.db.insert(products).values({ orgId, projectId: p!.id, name: 'Oil' }).returning();
  const [v] = await m.deps.db.insert(variants).values({ orgId, jobId: j!.id, variantNo: 1, formatSlug: 'f', hookSlug: 'h', archetypeSlug: 'a', visualTreatment: 'v', strategicBet: 'b', status: 'completed' }).returning();
  const [rev] = await m.deps.db.insert(variantRevisions).values({ orgId, variantId: v!.id, ops: [], beats: [], status: 'ready' }).returning();
  const fns = new Map(createFunctions(m.deps).map((f) => [f.id(), f]));
  return { orgId, revisionId: rev!.id, jobId: j!.id, productId: pr!.id, operatorJobId: await jobRow(m.deps), fns };
}

const TASKS = Object.keys(HEAVY) as (keyof typeof HEAVY)[];

describe('Inngest handlers run inside the owning org storage scope', () => {
  it('generate-ads, heavy-* and product-ingest run their bodies inside the owning org scope', async () => {
    const { orgId, jobId, productId, operatorJobId, fns } = await setup();
    for (const t of TASKS) vi.spyOn(HEAVY, t).mockImplementation((async () => { seen.push([`heavy-${t} step`, storageOrg()]); return null; }) as never);

    for (const t of TASKS) expect((await execute(fns.get(`heavy-${t}`)!, { jobId })).type).toBe('step-ran');
    expect((await execute(fns.get('generate-ads')!, { jobId })).type).toBe('step-ran');
    // A stray jobId (of another org) on an ingest event must not pick the scope: the product's org owns the puts.
    expect((await execute(fns.get('product-ingest')!, { productId, jobId: operatorJobId, photoAssetIds: [randomUUID()] })).type).toBe('step-ran');

    expect(seen).toEqual([
      ...TASKS.map((t) => [`heavy-${t} step`, orgId]),
      ['generate-ads body', orgId], ['generate-ads step', orgId],
      ['product-ingest body', orgId], ['product-ingest step', orgId],
    ]);
    expect(storageOrg()).toBeUndefined();
  });

  it('variant-edit, variant-export and revision-keyed heavy events take the org from the revision row', async () => {
    const { orgId, revisionId, fns } = await setup();
    for (const t of ['voiceLines', 'plateLines'] as const) vi.spyOn(HEAVY, t).mockImplementation((async () => { seen.push([`heavy-${t} step`, storageOrg()]); return null; }) as never);
    for (const id of ['heavy-voiceLines', 'heavy-plateLines', 'variant-edit', 'variant-export']) expect((await execute(fns.get(id)!, { revisionId })).type).toBe('step-ran');
    expect(seen).toEqual([
      ['heavy-voiceLines step', orgId], ['heavy-plateLines step', orgId],
      ['variant-edit body', orgId], ['variant-edit step', orgId],
      ['variant-export body', orgId], ['variant-export step', orgId],
    ]);
    expect((await execute(fns.get('variant-edit')!, { revisionId: randomUUID() })).retriable).toBe(false);
  });

  it('an event whose job/product does not exist fails non-retriably before any put', async () => {
    const { fns } = await setup();
    for (const t of TASKS) vi.spyOn(HEAVY, t).mockImplementation((async () => { seen.push([`heavy-${t}`, storageOrg()]); return null; }) as never);
    const missing = randomUUID();

    const outcomes = [
      ...(await Promise.all(TASKS.map((t) => execute(fns.get(`heavy-${t}`)!, { jobId: missing })))),
      await execute(fns.get('generate-ads')!, { jobId: missing }),
      await execute(fns.get('product-ingest')!, { productId: missing, photoAssetIds: [randomUUID()] }),
      await execute(fns.get('generate-ads')!, {}),
      await execute(fns.get('product-ingest')!, { productId: 'not-a-uuid' }),
    ];
    for (const o of outcomes) expect(o).toMatchObject({ type: 'function-rejected', retriable: false, error: { name: 'NonRetriableError', message: expect.stringMatching(/not found|no valid jobId, productId or revisionId/) } });
    expect(seen).toEqual([]);
  });
});
