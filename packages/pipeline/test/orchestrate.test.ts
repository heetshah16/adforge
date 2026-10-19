import { afterEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { loadPrompt } from '@adforge/core/llm/prompts';
import { ProviderError } from '@adforge/core/providers/types';
import { assets, jobs, orgs, projects, providerCalls, variants } from '@adforge/db/schema';
import { seedOperator } from '@adforge/db/seed/seed';
import { HEAVY } from '../src/heavy';
import { generateAds } from '../src/orchestrate';
import type { PipelineDeps, StepLike } from '../src/types';
import { PLATE, anchor, makeDeps, realPng } from './fakes';

/** buildSpec stays real; a test can make one variant's spec throw. */
const specFault = vi.hoisted(() => ({ variantNo: 0 }));
vi.mock('@adforge/core/spec/build-spec', async (orig) => {
  const m = await orig<typeof import('@adforge/core/spec/build-spec')>();
  return { ...m, buildSpec: (i: Parameters<typeof m.buildSpec>[0]) => { if (i.variant.variant_no === specFault.variantNo) throw new Error('spec boom'); return m.buildSpec(i); } };
});

/** Memoizing fake of Inngest's step: JSON round-trip like the real one; heavy tasks run inline. */
function memoStep(deps: PipelineDeps, cache = new Map<string, unknown>()): StepLike & { cache: Map<string, unknown> } {
  const run = async <T>(id: string, fn: () => Promise<T>): Promise<T> => {
    if (!cache.has(id)) cache.set(id, JSON.parse(JSON.stringify((await fn()) ?? null)));
    return cache.get(id) as T;
  };
  return {
    cache,
    run,
    heavy: (task, id, payload) => run(id, () => (HEAVY[task] as (d: PipelineDeps, p: unknown) => Promise<unknown>)(deps, payload)) as never,
  };
}

let close: (() => Promise<void>) | undefined;
afterEach(async () => { await close?.(); close = undefined; specFault.variantNo = 0; });

async function newJob(deps: PipelineDeps, broll = false, scope?: { orgId: string; projectId: string; userId: string }) {
  const photos = await Promise.all([1, 2, 3].map((i) => realPng(i).then((b) => deps.storage.put(b, { mime: 'image/png' }))));
  const [job] = await deps.db.insert(jobs).values({
    ...(scope ?? (await seedOperator(deps.db))),
    inputSpec: { product: { name: 'Sattvik Oil', price: '₹450', description: 'Wood-pressed groundnut oil.' }, language: 'en', broll, photoKeys: photos.map((p) => p.id) },
  }).returning();
  return job!.id;
}

describe('generateAds', () => {
  it('a rejected photo fails the job at stage normalize with the message; no plates step runs', async () => {
    const m = await makeDeps(); close = m.close;
    const id = await newJob(m.deps);
    const [j0] = await m.deps.db.select().from(jobs).where(eq(jobs.id, id));
    const spec = j0!.inputSpec as { photoKeys: string[] };
    spec.photoKeys[1] = (await m.deps.storage.put(new Uint8Array([137, 80, 78, 71, 9, 9]), { mime: 'image/png' })).id;
    await m.deps.db.update(jobs).set({ inputSpec: spec }).where(eq(jobs.id, id));
    const step = memoStep(m.deps);
    const r = await generateAds(id, step, m.deps);
    expect(r.status).toBe('failed');
    const [j] = await m.deps.db.select().from(jobs).where(eq(jobs.id, id));
    expect(j!.status).toBe('failed');
    expect(j!.error).toMatchObject({ stage: 'normalize', reason: 'photo 2: could not read this image' });
    expect(j!.progress.findLast((p) => p.stage === 'normalize')?.status).toBe('failed');
    expect([...step.cache.keys()].some((k) => k.includes('plates'))).toBe(false);
    expect(m.calls.llm).toBe(0);
  });

  it('a photo whose stored bytes no longer match its key sha fails the job at normalize as corrupted', async () => {
    const m = await makeDeps(); close = m.close;
    const id = await newJob(m.deps);
    const [j0] = await m.deps.db.select().from(jobs).where(eq(jobs.id, id));
    const keys = (j0!.inputSpec as { photoKeys: string[] }).photoKeys;
    const read = m.deps.storage.read.bind(m.deps.storage);
    m.deps.storage.read = async (k: string) => (k === keys[0] ? read(keys[1]!) : read(k));
    const r = await generateAds(id, memoStep(m.deps), m.deps);
    expect(r.status).toBe('failed');
    const [j] = await m.deps.db.select().from(jobs).where(eq(jobs.id, id));
    expect(j!.error).toMatchObject({ stage: 'normalize', reason: 'photo 1 is corrupted — upload it again' });
  });

  it('analyses every plate: PlateAnalysis + luma grid + depth key stored on the plate asset, one recorded LLM call each, vision unloaded', async () => {
    const m = await makeDeps(); close = m.close;
    const id = await newJob(m.deps);
    const r = await generateAds(id, memoStep(m.deps), m.deps);
    expect(r).toEqual({ status: 'completed', warnings: [] });
    const plates = await m.deps.db.select().from(assets).where(eq(assets.kind, 'plate'));
    expect(plates.length).toBeGreaterThan(0);
    for (const p of plates) {
      expect(p.analysis).toMatchObject({ plate: PLATE, lumaGrid: [[10, 20], [30, 40]], depthKey: expect.stringMatching(/\.png$/) });
    }
    expect([m.calls.plateLlm, m.calls.luma, m.calls.depth]).toEqual([plates.length, plates.length, plates.length]);
    expect(m.calls.visionUnload).toBe(1);
    const llm = (await m.deps.db.select().from(providerCalls)).filter((c) => c.idempotencyKey.includes(':plate-analysis:'));
    expect(llm).toHaveLength(plates.length);
    expect(llm.every((c) => c.model === 'claude-sonnet-5-5' && c.status === 'done')).toBe(true);
  });

  it('plate analyses run concurrently, all are stored, and the aggregate warning still counts the failures', async () => {
    const m = await makeDeps({ plateTransient: 0 }); close = m.close;
    const id = await newJob(m.deps);
    const gen = m.deps.llm.generate.bind(m.deps.llm);
    let live = 0, peak = 0, nth = 0;
    m.deps.llm.generate = (async (req: Parameters<typeof gen>[0]) => {
      if (req.system !== loadPrompt('vision-plate').text) return gen(req);
      live++; peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 20));
      live--;
      return ++nth <= 2 ? { status: 'failed', error: new ProviderError('fake', 'INVALID_INPUT', 'nope'), retryable: false } : gen(req);
    }) as typeof gen;
    const r = await generateAds(id, memoStep(m.deps), m.deps);
    const plates = await m.deps.db.select().from(assets).where(eq(assets.kind, 'plate'));
    expect(peak).toBeGreaterThan(1);
    expect(plates.filter((p) => p.analysis !== null)).toHaveLength(plates.length - 2);
    expect(r.warnings.filter((w) => w.startsWith('plate analysis failed'))).toEqual([`plate analysis failed for 2/${plates.length} plates (first: nope)`]);
  });

  it('a retryable plate-analysis failure is retried once in-step; the retry is recorded', async () => {
    const m = await makeDeps({ plateTransient: 1 }); close = m.close;
    const id = await newJob(m.deps);
    const r = await generateAds(id, memoStep(m.deps), m.deps);
    expect(r.warnings.filter((w) => !w.startsWith('voice bible'))).toEqual([]);
    const plates = await m.deps.db.select().from(assets).where(eq(assets.kind, 'plate'));
    expect(plates.every((p) => p.analysis !== null)).toBe(true);
    expect(m.calls.plateLlm).toBe(plates.length + 1);
    const rows = (await m.deps.db.select().from(providerCalls)).filter((c) => c.idempotencyKey.endsWith(':retry1'));
    expect(rows).toHaveLength(1);
  });

  it('records which voice the job used (config snapshot); no brand and no voice rows is silent', async () => {
    const m = await makeDeps(); close = m.close;
    const id = await newJob(m.deps);
    const r = await generateAds(id, memoStep(m.deps), m.deps);
    const [j] = await m.deps.db.select().from(jobs).where(eq(jobs.id, id));
    expect(j!.configSnapshot).toMatchObject({ voice: 'config-defaults', models: { director: 'claude-opus-5-5' } });
    expect(r.warnings).toEqual([]);
  });

  it.each([['depth service down', { depthDown: true }], ['plate LLM failing', { plateAnalysisFails: true }]])('%s → the job still completes, with warnings and no analysis', async (_n, ctl) => {
    const m = await makeDeps(ctl); close = m.close;
    const id = await newJob(m.deps);
    const r = await generateAds(id, memoStep(m.deps), m.deps);
    expect(r.status).toBe('completed');
    expect(r.warnings.length).toBeGreaterThan(0);
    expect(r.warnings.filter((w) => w.startsWith('plate analysis failed'))).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/^plate analysis failed for \d+\/\d+ plates \(first: .+\)$/);
    const plates = await m.deps.db.select().from(assets).where(eq(assets.kind, 'plate'));
    expect(plates.every((p) => p.analysis === null)).toBe(true);
    const [j] = await m.deps.db.select().from(jobs).where(eq(jobs.id, id));
    expect(j!.error).toMatchObject({ warnings: r.warnings });
  });

  it('runs end to end: 3 completed variants with renders, progress, snapshot and recorded calls', async () => {
    const m = await makeDeps(); close = m.close;
    const id = await newJob(m.deps);
    const r = await generateAds(id, memoStep(m.deps), m.deps);
    expect(r).toEqual({ status: 'completed', warnings: [] });
    const vs = await m.deps.db.select().from(variants).where(eq(variants.jobId, id));
    expect(vs.map((v) => v.status).sort()).toEqual(['completed', 'completed', 'completed']);
    expect(vs.every((v) => v.renderAssetId)).toBe(true);
    const [j] = await m.deps.db.select().from(jobs).where(eq(jobs.id, id));
    expect(j!.status).toBe('completed');
    expect(j!.progress.map((p) => p.stage)).toEqual(expect.arrayContaining(['preflight', 'strategize', 'direct', 'plates', 'broll', 'voice', 'render', 'finalize']));
    expect(j!.progress.find((p) => p.stage === 'broll')?.status).toBe('skipped');
    expect(j!.configSnapshot).toMatchObject({ models: { director: 'claude-opus-5-5' } });
    expect(await m.deps.db.$count(providerCalls)).toBeGreaterThanOrEqual(12 + 1 + 24 + 3);
    expect(m.calls.free).toBeGreaterThanOrEqual(1);
    expect(m.calls.unload).toBe(1);
  });

  it('a job in org X writes its assets, variants and provider calls with orgId = X', async () => {
    const m = await makeDeps(); close = m.close;
    const [x] = await m.deps.db.insert(orgs).values({ name: 'X' }).returning();
    const [px] = await m.deps.db.insert(projects).values({ orgId: x!.id, userId: m.op.userId, name: 'x' }).returning();
    const id = await newJob(m.deps, true, { orgId: x!.id, projectId: px!.id, userId: m.op.userId });
    expect((await generateAds(id, memoStep(m.deps), m.deps)).status).toBe('completed');
    const as = await m.deps.db.select().from(assets);
    expect(as.length).toBeGreaterThan(0);
    expect(as.every((a) => a.orgId === x!.id && a.projectId === px!.id)).toBe(true);
    const vs = await m.deps.db.select().from(variants);
    expect(vs.length === 3 && vs.every((v) => v.orgId === x!.id)).toBe(true);
    const cs = await m.deps.db.select().from(providerCalls);
    expect(cs.length > 0 && cs.every((c) => c.orgId === x!.id)).toBe(true);
  });

  it('a retried run with the same step cache calls no provider twice', async () => {
    const m = await makeDeps(); close = m.close;
    const id = await newJob(m.deps);
    const step = memoStep(m.deps);
    await generateAds(id, step, m.deps);
    const before = { ...m.calls };
    await generateAds(id, step, m.deps);
    expect(m.calls).toEqual(before);
  });

  it('a step that throws mid-job is retried without re-calling providers of steps that already succeeded', async () => {
    const m = await makeDeps(); close = m.close;
    const id = await newJob(m.deps);
    const synth = m.deps.voice.tts.synthesize;
    let blowUp = true;
    m.deps.voice.tts.synthesize = async (req) => { if (blowUp) { blowUp = false; throw new Error('worker died'); } return synth(req); };
    const step = memoStep(m.deps);
    await expect(generateAds(id, step, m.deps)).rejects.toThrow('worker died');
    const before = { llm: m.calls.llm, image: m.calls.image, cutout: m.calls.cutout };
    expect(before).toEqual({ llm: 2, image: 12, cutout: 1 });
    const r = await generateAds(id, step, m.deps); // Inngest's retry: same memo, voice step re-runs
    expect(r.status).toBe('completed');
    expect({ llm: m.calls.llm, image: m.calls.image, cutout: m.calls.cutout }).toEqual(before);
  });

  it('one failed render → completed with a warning; all failed → failed', async () => {
    const one = await makeDeps({ failRender: [2] }); close = one.close;
    const r1 = await generateAds(await newJob(one.deps), memoStep(one.deps), one.deps);
    expect(r1.status).toBe('completed');
    expect(r1.warnings.join()).toMatch(/variant 2/);
    await one.close();
    const all = await makeDeps({ failRender: [1, 2, 3] }); close = all.close;
    const r2 = await generateAds(await newJob(all.deps), memoStep(all.deps), all.deps);
    expect(r2.status).toBe('failed');
  });

  it('a spec that will not build fails that variant only; the others still render', async () => {
    const m = await makeDeps(); close = m.close;
    specFault.variantNo = 1;
    const id = await newJob(m.deps);
    const r = await generateAds(id, memoStep(m.deps), m.deps);
    expect(r.status).toBe('completed');
    expect(r.warnings.join()).toMatch(/variant 1: spec failed: spec boom/);
    const vs = await m.deps.db.select().from(variants).where(eq(variants.jobId, id));
    expect(Object.fromEntries(vs.map((v) => [v.variantNo, v.status]))).toEqual({ 1: 'failed', 2: 'completed', 3: 'completed' });
    expect(m.calls.render).toBe(2);
  });

  it('a corrupt memoized spec fails that variant only, never the function', async () => {
    const m = await makeDeps(); close = m.close;
    const id = await newJob(m.deps);
    const r = await generateAds(id, memoStep(m.deps, new Map([['spec:2', { spec: { id: 'corrupt' } }]])), m.deps);
    expect(r.status).toBe('completed');
    expect(r.warnings.join()).toMatch(/variant 2: spec failed/);
    const vs = await m.deps.db.select().from(variants).where(eq(variants.jobId, id));
    expect(Object.fromEntries(vs.map((v) => [v.variantNo, v.status]))).toEqual({ 1: 'completed', 2: 'failed', 3: 'completed' });
    expect(m.calls.render).toBe(2);
  });

  it('a b-roll invoke that throws completes the job with a warning', async () => {
    const m = await makeDeps(); close = m.close;
    const step = memoStep(m.deps);
    const heavy = step.heavy;
    step.heavy = ((task: string, id: string, payload: unknown) => (task === 'broll' ? Promise.reject(new Error('invoke timed out')) : (heavy as Function)(task, id, payload))) as never;
    const id = await newJob(m.deps, true);
    const r = await generateAds(id, step, m.deps);
    expect(r.status).toBe('completed');
    expect(r.warnings).toContain('b-roll unavailable: invoke timed out');
  });

  it('finalize does not resurrect a job the janitor already failed', async () => {
    const m = await makeDeps(); close = m.close;
    const step = memoStep(m.deps);
    const id = await newJob(m.deps);
    const run = step.run;
    step.run = (async (sid: string, fn: () => Promise<unknown>) => {
      if (sid === 'finalize') await m.deps.db.update(jobs).set({ status: 'failed', error: { stage: 'janitor' } }).where(eq(jobs.id, id));
      return run(sid, fn as never);
    }) as never;
    await generateAds(id, step, m.deps);
    const [j] = await m.deps.db.select().from(jobs).where(eq(jobs.id, id));
    expect(j!.status).toBe('failed');
    expect(j!.error).toEqual({ stage: 'janitor' });
  });

  it('a failed b-roll degrades to the plate and the job still completes', async () => {
    const m = await makeDeps({ failBroll: true }); close = m.close;
    const seen: unknown[] = [];
    const orig = m.deps.renderer.render;
    m.deps.renderer = { id: 'fake', render: async (req) => { seen.push(req.spec); return orig(req); } };
    const r = await generateAds(await newJob(m.deps, true), memoStep(m.deps), m.deps);
    expect(r.status).toBe('completed');
    expect(JSON.stringify(seen)).not.toContain('"type":"video"');
    expect(r.warnings.join()).toMatch(/b-roll/);
  });

  it('a Director that fails the diversity rule twice fails the job with the violations', async () => {
    const collide = () => { const o = anchor(); o.variants[2]!.hook_archetype = 'curiosity_gap'; return o; };
    const m = await makeDeps({ director: [collide(), collide()] }); close = m.close;
    const id = await newJob(m.deps);
    const r = await generateAds(id, memoStep(m.deps), m.deps);
    expect(r.status).toBe('failed');
    const [j] = await m.deps.db.select().from(jobs).where(eq(jobs.id, id));
    expect(JSON.stringify(j!.error)).toContain('hook_family');
    expect(m.calls.image).toBe(0);
  });

  it('preflight fails fast when the voice service lacks sm_120 or ComfyUI is down', async () => {
    for (const ctl of [{ voiceSm120: false }, { comfyDown: true }]) {
      const m = await makeDeps(ctl);
      const id = await newJob(m.deps);
      const r = await generateAds(id, memoStep(m.deps), m.deps);
      expect(r.status).toBe('failed');
      expect(m.calls.llm).toBe(0);
      await m.close();
    }
  });
});
