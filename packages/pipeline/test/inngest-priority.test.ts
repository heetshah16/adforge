import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InngestFunction } from 'inngest';
import { jobs, variantRevisions, variants } from '@adforge/db/schema';
import { HEAVY_PRIORITY, createFunctions, inngest } from '../src/inngest';
import { jobRow, makeDeps } from './fakes';

// Each body makes one heavy invoke; the engine reports it as an InvokeFunction op whose payload we inspect.
type S = { heavy: (task: string, id: string, payload: unknown) => Promise<unknown> };
vi.mock('../src/orchestrate', () => ({ generateAds: async (jobId: string, s: S) => s.heavy('voice', 'heavy:voice', { jobId }) }));
vi.mock('../src/edit', () => ({
  failRevision: async () => undefined,
  editVariant: async (revisionId: string, s: S) => s.heavy('voiceLines', 'heavy:voiceLines', { revisionId }),
  exportRevision: async (revisionId: string, s: S) => s.heavy('render', 'heavy:render', { revisionId }),
}));

type Op = { op: string; opts?: { payload?: { data?: Record<string, unknown> } } };
type Outcome = { type: string; steps?: Op[]; step?: Op };
function execute(fn: InngestFunction.Any, data: Record<string, unknown>): Promise<Outcome> {
  const name = (fn.opts.triggers as { event?: string }[] | undefined)?.[0]?.event ?? 'inngest/function.invoked';
  const event = { name, data };
  const exec = (fn as unknown as { createExecution(o: unknown): { start(): Promise<Outcome> } }).createExecution({
    partialOptions: { client: inngest, data: { event, events: [event], runId: 'run-1', attempt: 0 }, runId: 'run-1', stepState: {}, stepCompletionOrder: [], stepMode: 'async', reqArgs: [], headers: {} },
  });
  return exec.start();
}
const invokeData = (o: Outcome) => {
  const op = [...(o.steps ?? []), ...(o.step ? [o.step] : [])].find((s) => s.op === 'InvokeFunction');
  return op?.opts?.payload?.data;
};

let close: (() => Promise<void>) | undefined;
afterEach(async () => { await close?.(); close = undefined; });

describe('priority', () => {
  it('heavy functions read event.data.priority; product-ingest stays interactive', async () => {
    const m = await makeDeps(); close = m.close;
    const fns = createFunctions(m.deps);
    expect(HEAVY_PRIORITY).toEqual({ run: "event.data.priority == 'interactive' ? 600 : 0" });
    for (const f of fns.filter((x) => x.id().startsWith('heavy-'))) expect(f.opts.priority, f.id()).toEqual(HEAVY_PRIORITY);
    expect(fns.find((f) => f.id() === 'product-ingest')!.opts.priority).toEqual({ run: '600' });
  });

  it("generate-ads invokes heavy work with priority 'job'; edit and export pass the parent event's priority through", async () => {
    const m = await makeDeps(); close = m.close;
    const fns = new Map(createFunctions(m.deps).map((f) => [f.id(), f]));
    const jobId = await jobRow(m.deps);
    await m.deps.db.update(jobs).set({ status: 'completed' });
    const [v] = await m.deps.db.insert(variants).values({ orgId: m.op.orgId, jobId, variantNo: 1, formatSlug: 'f', hookSlug: 'h', archetypeSlug: 'a', visualTreatment: 'v', strategicBet: 'b', status: 'completed' }).returning();
    const [rev] = await m.deps.db.insert(variantRevisions).values({ orgId: m.op.orgId, variantId: v!.id, ops: [], beats: [], status: 'ready' }).returning();
    expect(invokeData(await execute(fns.get('generate-ads')!, { jobId, priority: 'job' }))).toEqual({ jobId, priority: 'job' });
    expect(invokeData(await execute(fns.get('generate-ads')!, { jobId }))).toEqual({ jobId, priority: 'job' });
    expect(invokeData(await execute(fns.get('variant-edit')!, { revisionId: rev!.id, priority: 'interactive' }))).toEqual({ revisionId: rev!.id, priority: 'interactive' });
    expect(invokeData(await execute(fns.get('variant-export')!, { revisionId: rev!.id, priority: 'interactive' }))).toEqual({ revisionId: rev!.id, priority: 'interactive' });
  });

  it('a heavy function strips priority before the task sees its payload', async () => {
    const m = await makeDeps(); close = m.close;
    const fns = new Map(createFunctions(m.deps).map((f) => [f.id(), f]));
    const jobId = await jobRow(m.deps);
    const seen: unknown[] = [];
    const heavy = await import('../src/heavy');
    const spy = vi.spyOn(heavy.HEAVY, 'voice').mockImplementation(async (_d, p) => { seen.push(p); return { beats: {}, voiceUsed: 'x' }; });
    try {
      await execute(fns.get('heavy-voice')!, { jobId, priority: 'job' });
      expect(seen).toEqual([{ jobId }]);
    } finally { spy.mockRestore(); }
  });
});
