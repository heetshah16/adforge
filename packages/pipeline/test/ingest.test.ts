import { afterEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { loadPrompt } from '@adforge/core/llm/prompts';
import type { LLMProvider, LLMRequest } from '@adforge/core/providers/types';
import { labelTextViolations } from '@adforge/core/understand/schemas';
import { assets, libraryAssets, orgs, products, projects, providerCalls } from '@adforge/db/schema';
import { ingestProduct, updateDescriptor, type IngestStep } from '../src/ingest';
import { saveAsset } from '../src/record';
import { buildConfigSnapshot } from '../src/snapshot';
import type { PipelineDeps } from '../src/types';
import { makeDeps, type FakeControls } from './fakes';

const DESC =
  'a slim cylindrical amber glass bottle with a tall narrow neck and a matte black screw cap, the body wrapped by a wide cream paper label ' +
  'that covers the middle of the body, a red band with white latin and devanagari script across the upper label, a small round green seal ' +
  'at top left, and a thin gold rule along the bottom edge of the label above a plain glass base that catches a soft highlight on its left shoulder';
const analysis = (o: Record<string, unknown> = {}) => ({
  shapeClass: 'bottle', viewpoint: { azimuthDeg: 0, elevationDeg: 10 }, lightDirection: { azimuthDeg: -45, elevationDeg: 30 },
  palette: ['#aa5500', '#f5ecd7'], material: 'amber glass', finish: 'gloss', visibleFaces: ['front'], descriptor: DESC, bestPhotoIndex: 0, ...o,
});

/** Canned analyses in call order; records every request. */
function fakeVision(outputs: Record<string, unknown>[]) {
  const reqs: LLMRequest<unknown>[] = [];
  const llm: LLMProvider = {
    id: 'fake-llm',
    async generate(req) {
      reqs.push(req as LLMRequest<unknown>);
      const value = req.schema.parse(outputs.shift() ?? analysis());
      return { status: 'done', value: { value, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 } }, cost: { amountUsd: 0.01, estimated: true }, latencyMs: 1 };
    },
  };
  return { llm, reqs };
}

/** Inngest's step: results JSON round-trip. Each call is its own run. */
let runs = 0;
const step: IngestStep = { get runId() { return `run-${++runs}`; }, run: async (_id, fn) => JSON.parse(JSON.stringify((await fn()) ?? null)) };
/** One run retried by Inngest: memoizes each successful step by id (a throwing step is not cached and re-runs). */
function memoStep(runId = 'run-memo'): IngestStep & { ids: string[] } {
  const cache = new Map<string, unknown>();
  const ids: string[] = [];
  return {
    runId, ids,
    run: async <T>(id: string, fn: () => Promise<T>): Promise<T> => {
      if (!cache.has(id)) { ids.push(id); cache.set(id, JSON.parse(JSON.stringify((await fn()) ?? null))); }
      return cache.get(id) as T;
    },
  };
}

let close: (() => Promise<void>) | undefined;
afterEach(async () => { await close?.(); close = undefined; });

type Scope = { orgId: string; projectId: string };
async function setup(ctl: FakeControls = {}, outputs: Record<string, unknown>[] = []) {
  const m = await makeDeps(ctl); close = m.close;
  const v = fakeVision(outputs);
  m.deps.llm = v.llm;
  return { ...m, reqs: v.reqs, scope: { orgId: m.op.orgId, projectId: m.op.projectId } };
}
async function product(deps: PipelineDeps, scope: Scope, name = 'Sattvik Oil') {
  const [p] = await deps.db.insert(products).values({ ...scope, name }).returning();
  return p!.id;
}
async function photos(deps: PipelineDeps, scope: Scope, n: number, seed = 0, kind = 'upload') {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) ids.push(await saveAsset(deps.db, scope, kind, await deps.storage.put(new Uint8Array([137, 80, 78, 71, seed, i]), { mime: 'image/png' })));
  return ids;
}
const rows = (deps: PipelineDeps, orgId?: string) =>
  deps.db.select().from(libraryAssets).where(orgId ? eq(libraryAssets.orgId, orgId) : undefined).orderBy(libraryAssets.tag);

describe('product.ingest', () => {
  it('1 photo → 1 anchor row with every meta field; GPU freed after each phase; calls recorded and attributable', async () => {
    const m = await setup();
    const productId = await product(m.deps, m.scope);
    const [photoId] = await photos(m.deps, m.scope, 1);
    const r = await ingestProduct({ productId, photoAssetIds: [photoId!] }, step, m.deps);
    expect(r).toMatchObject({ status: 'ingested', tags: [{ tag: '@prod_sattvikoil_front', version: 1, anchor: true }] });
    expect(r.analysis).toEqual({ model: 'claude-sonnet-5-5', effort: 'low', prompts: { visionProduct: loadPrompt('vision-product').sha256, visionPlate: loadPrompt('vision-plate').sha256 } });

    const [row] = await rows(m.deps);
    expect(row).toMatchObject({ orgId: m.scope.orgId, projectId: m.scope.projectId, productId, kind: 'product_view', version: 1, status: 'active', descriptor: DESC });
    expect(row!.storageKey).toMatch(/\.png$/);
    expect(row!.meta).toMatchObject({
      anchor: true, sourceAssetId: photoId, cutoutKey: expect.stringMatching(/\.png$/),
      ocr: [{ text: 'KRISHNA HING RAS', box: [0.1, 0.1, 0.5, 0.1], conf: 0.9 }],
      viewpoint: { azimuthDeg: 0, elevationDeg: 10 }, palette: ['#aa5500', '#f5ecd7'], lightDirection: { azimuthDeg: -45, elevationDeg: 30 },
      analysisModel: 'claude-sonnet-5-5', analysisPrompt: loadPrompt('vision-product').sha256,
    });
    expect((row!.meta as { cutoutKey: string }).cutoutKey).not.toBe(row!.storageKey);

    expect([m.calls.cutout, m.calls.free, m.calls.ocr, m.calls.visionUnload, m.reqs.length]).toEqual([1, 1, 1, 1, 1]);
    const cs = await m.deps.db.select().from(providerCalls);
    expect(cs.map((c) => c.kind).sort()).toEqual(['cutout', 'llm', 'ocr']);
    expect(cs.every((c) => c.orgId === m.scope.orgId && c.status === 'done' && c.idempotencyKey.startsWith(`ingest:${m.scope.orgId}:${productId}:`))).toBe(true);
    expect(cs.find((c) => c.kind === 'llm')!.model).toBe('claude-sonnet-5-5');
  });

  it('3 photos → 3 rows named by face + azimuth bucket, the anchor at bestPhotoIndex', async () => {
    // Joint call picks photo 1; photos 0 and 2 each get their own view analysis.
    const m = await setup({}, [
      analysis({ bestPhotoIndex: 1 }),
      analysis({ viewpoint: { azimuthDeg: -90, elevationDeg: 0 }, visibleFaces: ['left'], palette: ['#000000'], material: 'tin', finish: 'matte', shapeClass: 'can' }),
      analysis({ viewpoint: { azimuthDeg: 45, elevationDeg: 5 }, visibleFaces: ['front', 'right'], lightDirection: null }),
    ]);
    const productId = await product(m.deps, m.scope);
    const ids = await photos(m.deps, m.scope, 3);
    const r = await ingestProduct({ productId, photoAssetIds: ids }, step, m.deps);
    expect(r.tags).toEqual([
      { tag: '@prod_sattvikoil_left', version: 1, anchor: false },
      { tag: '@prod_sattvikoil_front', version: 1, anchor: true },
      { tag: '@prod_sattvikoil_front_threequarterright', version: 1, anchor: false },
    ]);
    expect(m.reqs.map((q) => q.user.filter((c) => c.type === 'image').length)).toEqual([3, 1, 1]);
    const rs = await rows(m.deps);
    expect(rs).toHaveLength(3);
    const bySource = Object.fromEntries(rs.map((x) => [(x.meta as { sourceAssetId: string }).sourceAssetId, x.meta as { anchor: boolean; viewpoint: unknown; lightDirection: unknown }]));
    expect(ids.map((id) => bySource[id]!.anchor)).toEqual([false, true, false]);
    expect(bySource[ids[0]!]!.viewpoint).toEqual({ azimuthDeg: -90, elevationDeg: 0 });
    // Product-level fields come from the joint call; per-photo calls contribute only the view.
    for (const x of rs) expect(x.meta).toMatchObject({ palette: ['#aa5500', '#f5ecd7'], material: 'amber glass', finish: 'gloss', shapeClass: 'bottle' });
    expect(bySource[ids[2]!]!.lightDirection).toBeNull();
    expect([m.calls.cutout, m.calls.free, m.calls.ocr, m.calls.visionUnload]).toEqual([3, 1, 3, 1]);
  });

  it('two photos with the same view get distinct tags', async () => {
    const m = await setup({}, [analysis({ bestPhotoIndex: 0 }), analysis()]);
    const productId = await product(m.deps, m.scope);
    const r = await ingestProduct({ productId, photoAssetIds: await photos(m.deps, m.scope, 2) }, step, m.deps);
    expect(r.tags!.map((t) => t.tag)).toEqual(['@prod_sattvikoil_front', '@prod_sattvikoil_front_2']);
  });

  it('the same photos ingested twice (any order) → no new rows and no provider calls', async () => {
    const m = await setup({}, [analysis({ bestPhotoIndex: 0 })]);
    const productId = await product(m.deps, m.scope);
    const ids = await photos(m.deps, m.scope, 2);
    await ingestProduct({ productId, photoAssetIds: ids }, step, m.deps);
    const before = { ...m.calls, llm: m.reqs.length, calls: await m.deps.db.$count(providerCalls) };
    const again = await ingestProduct({ productId, photoAssetIds: [...ids].reverse() }, step, m.deps);
    expect(again.status).toBe('skipped');
    expect(await m.deps.db.$count(libraryAssets)).toBe(2);
    expect({ ...m.calls, llm: m.reqs.length, calls: await m.deps.db.$count(providerCalls) }).toEqual(before);
  });

  it('a new photo set re-versions the tags and supersedes the previous views', async () => {
    const m = await setup();
    const productId = await product(m.deps, m.scope);
    await ingestProduct({ productId, photoAssetIds: await photos(m.deps, m.scope, 1, 1) }, step, m.deps);
    const r = await ingestProduct({ productId, photoAssetIds: await photos(m.deps, m.scope, 1, 2) }, step, m.deps);
    expect(r.tags).toEqual([{ tag: '@prod_sattvikoil_front', version: 2, anchor: true }]);
    expect((await rows(m.deps)).map((x) => [x.version, x.status])).toEqual(expect.arrayContaining([[1, 'superseded'], [2, 'active']]));
    // Back to the first set in a later run: it re-versions, and its paid LLM call gets its own provider_calls row.
    const back = await ingestProduct({ productId, photoAssetIds: [(await rows(m.deps)).find((x) => x.version === 1)!.meta as { sourceAssetId: string }].map((x) => x.sourceAssetId) }, step, m.deps);
    expect(back.tags).toEqual([{ tag: '@prod_sattvikoil_front', version: 3, anchor: true }]);
    expect(await m.deps.db.$count(providerCalls, eq(providerCalls.kind, 'llm'))).toBe(3);
  });

  it('a renamed product keeps its tags on re-ingest', async () => {
    const m = await setup();
    const productId = await product(m.deps, m.scope);
    await ingestProduct({ productId, photoAssetIds: await photos(m.deps, m.scope, 1, 1) }, step, m.deps);
    await m.deps.db.update(products).set({ name: 'Sattvik Groundnut Oil' }).where(eq(products.id, productId));
    const r = await ingestProduct({ productId, photoAssetIds: await photos(m.deps, m.scope, 1, 2) }, step, m.deps);
    expect(r.tags).toEqual([{ tag: '@prod_sattvikoil_front', version: 2, anchor: true }]);
  });

  it('a retried run re-invokes only the failed per-photo call; earlier calls stay memoized and the anchor is unchanged', async () => {
    const m = await setup({}, [
      analysis({ bestPhotoIndex: 1 }),
      analysis({ viewpoint: { azimuthDeg: -90, elevationDeg: 0 }, visibleFaces: ['left'] }),
      analysis({ viewpoint: { azimuthDeg: 45, elevationDeg: 5 }, visibleFaces: ['front', 'right'] }),
      analysis({ bestPhotoIndex: 0 }), // what a re-run joint call would say; must never be asked for
    ]);
    const gen = m.deps.llm.generate.bind(m.deps.llm);
    let n = 0;
    m.deps.llm.generate = (async (req: LLMRequest<unknown>) => {
      if (++n === 3) throw new Error('subscription hiccup'); // the third call (photo 2) dies once
      return gen(req);
    }) as LLMProvider['generate'];
    const productId = await product(m.deps, m.scope);
    const ids = await photos(m.deps, m.scope, 3);
    const s = memoStep();
    await expect(ingestProduct({ productId, photoAssetIds: ids }, s, m.deps)).rejects.toThrow(/analysis failed: UNKNOWN subscription hiccup/);
    expect(await m.deps.db.$count(libraryAssets)).toBe(0);
    const r = await ingestProduct({ productId, photoAssetIds: ids }, s, m.deps); // Inngest's retry: same run, same memo
    expect(n).toBe(4); // joint + photo 0 + photo 2 (failed) + photo 2 (retry): nothing re-billed
    expect(m.reqs.map((q) => q.user.filter((c) => c.type === 'image').length)).toEqual([3, 1, 1]);
    expect(r.tags.map((t) => t.anchor)).toEqual([false, true, false]);
    const sha = (await m.deps.db.select().from(assets).where(eq(assets.id, ids[2]!)))[0]!.sha256;
    expect(s.ids.filter((id) => id.startsWith('analyze:')).map((id) => id.replace(sha, 'photo2'))).toEqual(['analyze:joint', expect.stringMatching(/^analyze:[0-9a-f]{64}$/), 'analyze:photo2', 'analyze:photo2']);
    const llm = await m.deps.db.select().from(providerCalls).where(eq(providerCalls.kind, 'llm'));
    expect(llm.map((c) => c.status).sort()).toEqual(['done', 'done', 'done']); // the failed row was replaced by the retry's success
  });

  it('OCR [] → completes, and the descriptor carries no label text (an offending first draft is repaired)', async () => {
    const leaked = `${DESC} with the word "KRISHNA" printed large`;
    const m = await setup({ ocr: [] }, [analysis({ descriptor: leaked }), analysis()]);
    const productId = await product(m.deps, m.scope);
    const r = await ingestProduct({ productId, photoAssetIds: await photos(m.deps, m.scope, 1) }, step, m.deps);
    expect(r.status).toBe('ingested');
    const [row] = await rows(m.deps);
    expect((row!.meta as { ocr: unknown[] }).ocr).toEqual([]);
    expect(labelTextViolations(row!.descriptor)).toEqual([]);
    expect(m.reqs).toHaveLength(2); // one repair
    expect(JSON.stringify(m.reqs[0]!.user)).toContain('(none read)');
    expect((await m.deps.db.select().from(providerCalls).where(eq(providerCalls.kind, 'llm'))).map((c) => c.idempotencyKey.split(':').pop())).toEqual(['analysis', 'repair1']);
  });

  it('the vision service failing → the run fails with a recorded failed call, unloads, and writes no library rows', async () => {
    const m = await setup({ visionDown: true });
    const productId = await product(m.deps, m.scope);
    await expect(ingestProduct({ productId, photoAssetIds: await photos(m.deps, m.scope, 2) }, step, m.deps)).rejects.toThrow(/ocr failed/);
    expect(await m.deps.db.$count(libraryAssets)).toBe(0);
    const [c] = await m.deps.db.select().from(providerCalls).where(eq(providerCalls.kind, 'ocr'));
    expect(c).toMatchObject({ status: 'failed', provider: 'fake-ocr', error: { code: 'UPSTREAM', retryable: true } });
    expect([m.calls.free, m.calls.visionUnload, m.reqs.length]).toEqual([1, 1, 0]);
  });

  it('an LLM failure after the GPU phases → fails with a recorded call and no library rows', async () => {
    const m = await setup({}, [analysis({ descriptor: 'too short' }), analysis({ descriptor: 'still too short' })]);
    const productId = await product(m.deps, m.scope);
    await expect(ingestProduct({ productId, photoAssetIds: await photos(m.deps, m.scope, 1) }, step, m.deps)).rejects.toThrow(/descriptor still invalid/);
    expect(await m.deps.db.$count(libraryAssets)).toBe(0);
    expect((await m.deps.db.select().from(providerCalls).where(eq(providerCalls.kind, 'llm'))).map((c) => c.status)).toEqual(['done', 'failed']);
  });

  it('updateDescriptor → v2 active, v1 superseded and still resolvable; a label-text descriptor is refused', async () => {
    const m = await setup();
    const productId = await product(m.deps, m.scope);
    await ingestProduct({ productId, photoAssetIds: await photos(m.deps, m.scope, 1) }, step, m.deps);
    const tag = '@prod_sattvikoil_front';
    const next = DESC.replace('amber', 'dark amber');
    expect(await updateDescriptor(m.deps.db, { orgId: m.scope.orgId, tag, descriptor: next })).toBe(2);
    const at = async (version: number) => (await m.deps.db.select().from(libraryAssets).where(and(eq(libraryAssets.orgId, m.scope.orgId), eq(libraryAssets.tag, tag), eq(libraryAssets.version, version))))[0]!;
    const [v1, v2] = [await at(1), await at(2)];
    expect([v1.status, v1.descriptor]).toEqual(['superseded', DESC]);
    expect([v2.status, v2.descriptor]).toEqual(['active', next]);
    expect(v2.meta).toEqual(v1.meta);
    expect([v2.storageKey, v2.productId, v2.kind]).toEqual([v1.storageKey, v1.productId, v1.kind]);
    await expect(updateDescriptor(m.deps.db, { orgId: m.scope.orgId, tag, descriptor: `${DESC} "KRISHNA"` })).rejects.toThrow(/label text/);
    await expect(updateDescriptor(m.deps.db, { orgId: m.scope.orgId, tag: '@prod_nope_front', descriptor: next })).rejects.toThrow(/no active version/);
    expect(await m.deps.db.$count(libraryAssets)).toBe(2);
  });

  it('updateDescriptor never revives a superseded view', async () => {
    const m = await setup({}, [analysis(), analysis({ viewpoint: { azimuthDeg: -90, elevationDeg: 0 }, visibleFaces: ['left'] })]);
    const productId = await product(m.deps, m.scope);
    await ingestProduct({ productId, photoAssetIds: await photos(m.deps, m.scope, 1, 1) }, step, m.deps);
    await ingestProduct({ productId, photoAssetIds: await photos(m.deps, m.scope, 1, 2) }, step, m.deps); // now only a left view
    await expect(updateDescriptor(m.deps.db, { orgId: m.scope.orgId, tag: '@prod_sattvikoil_front', descriptor: DESC })).rejects.toThrow(/no active version/);
    expect(await m.deps.db.$count(libraryAssets)).toBe(2);
  });

  it('idempotency keys are org-scoped: the same bytes in two orgs ingest independently', async () => {
    const m = await setup();
    const [x] = await m.deps.db.insert(orgs).values({ name: 'X' }).returning();
    const [px] = await m.deps.db.insert(projects).values({ orgId: x!.id, userId: m.op.userId, name: 'x' }).returning();
    const sx = { orgId: x!.id, projectId: px!.id };
    for (const s of [m.scope, sx]) await ingestProduct({ productId: await product(m.deps, s), photoAssetIds: await photos(m.deps, s, 1) }, step, m.deps);
    expect((await rows(m.deps, m.scope.orgId)).map((r) => r.tag)).toEqual(['@prod_sattvikoil_front']);
    expect((await rows(m.deps, sx.orgId)).map((r) => r.tag)).toEqual(['@prod_sattvikoil_front']);
    expect(m.calls.cutout).toBe(2);
    const cs = await m.deps.db.select().from(providerCalls);
    expect(cs).toHaveLength(6);
    for (const c of cs) expect(c.idempotencyKey.startsWith(`ingest:${c.orgId}:`)).toBe(true);
  });

  it('product slugs: a Devanagari-only name falls back to the id; a colliding name in one org gets the id prefix', async () => {
    const m = await setup();
    const hindi = await product(m.deps, m.scope, 'हींग रस');
    const r1 = await ingestProduct({ productId: hindi, photoAssetIds: await photos(m.deps, m.scope, 1, 1) }, step, m.deps);
    expect(r1.tags![0]!.tag).toBe(`@prod_p${hindi.replace(/-/g, '').slice(0, 8)}_front`);
    const a = await product(m.deps, m.scope, 'Hing Ras');
    const b = await product(m.deps, m.scope, 'Hing-Ras!');
    const ra = await ingestProduct({ productId: a, photoAssetIds: await photos(m.deps, m.scope, 1, 2) }, step, m.deps);
    const rb = await ingestProduct({ productId: b, photoAssetIds: await photos(m.deps, m.scope, 1, 3) }, step, m.deps);
    expect(ra.tags![0]!.tag).toBe('@prod_hingras_front');
    expect(rb.tags![0]!.tag).toBe(`@prod_hingras${b.replace(/-/g, '').slice(0, 8)}_front`);
    // The first product keeps its slug on re-ingest.
    const ra2 = await ingestProduct({ productId: a, photoAssetIds: await photos(m.deps, m.scope, 1, 4) }, step, m.deps);
    expect(ra2.tags![0]).toEqual({ tag: '@prod_hingras_front', version: 2, anchor: true });
  });

  it('refuses photos from another org, non-upload assets and a bad payload — no rows, no provider calls', async () => {
    const m = await setup();
    const [x] = await m.deps.db.insert(orgs).values({ name: 'X' }).returning();
    const [px] = await m.deps.db.insert(projects).values({ orgId: x!.id, userId: m.op.userId, name: 'x' }).returning();
    const productId = await product(m.deps, m.scope);
    const foreign = await photos(m.deps, { orgId: x!.id, projectId: px!.id }, 1, 7);
    await expect(ingestProduct({ productId, photoAssetIds: foreign }, step, m.deps)).rejects.toThrow(/not an upload of this product's org/);
    const cutout = await photos(m.deps, m.scope, 1, 8, 'cutout');
    await expect(ingestProduct({ productId, photoAssetIds: cutout }, step, m.deps)).rejects.toThrow(/not an upload of this product's org/);
    await expect(ingestProduct({ productId, photoAssetIds: [] }, step, m.deps)).rejects.toThrow();
    await expect(ingestProduct({ productId: 'nope', photoAssetIds: cutout }, step, m.deps)).rejects.toThrow();
    expect(await m.deps.db.$count(libraryAssets)).toBe(0);
    expect(await m.deps.db.$count(providerCalls)).toBe(0);
    expect(m.calls.cutout).toBe(0);
  });

  it('refuses an unsupported image mime before any cutout or OCR', async () => {
    const m = await setup();
    const productId = await product(m.deps, m.scope);
    const ids = await photos(m.deps, m.scope, 2);
    await m.deps.db.update(assets).set({ mime: 'image/gif' }).where(eq(assets.id, ids[1]!));
    await expect(ingestProduct({ productId, photoAssetIds: ids }, step, m.deps)).rejects.toThrow(/image\/gif.*not an analysable image/);
    expect([m.calls.cutout, m.calls.ocr, await m.deps.db.$count(providerCalls), await m.deps.db.$count(libraryAssets)]).toEqual([0, 0, 0, 0]);
  });

  it('a throw inside the analysis (e.g. storage.read) is recorded as a failed llm call', async () => {
    const m = await setup();
    const productId = await product(m.deps, m.scope);
    const ids = await photos(m.deps, m.scope, 1);
    m.deps.storage.read = async () => { throw new Error('disk gone'); };
    await expect(ingestProduct({ productId, photoAssetIds: ids }, step, m.deps)).rejects.toThrow(/analysis failed: UNKNOWN disk gone/);
    const [c] = await m.deps.db.select().from(providerCalls).where(eq(providerCalls.kind, 'llm'));
    expect(c).toMatchObject({ status: 'failed', model: 'claude-sonnet-5-5', error: { code: 'UNKNOWN', message: 'disk gone', retryable: true } });
    expect(await m.deps.db.$count(libraryAssets)).toBe(0);
  });

  it('the job config snapshot records the vision model, effort and both vision prompt hashes', async () => {
    const m = await setup();
    expect(buildConfigSnapshot({ env: m.deps.env, workflowHashes: {} })).toMatchObject({
      models: { vision: 'claude-sonnet-5-5', visionEffort: 'low' },
      prompts: { visionProduct: loadPrompt('vision-product').sha256, visionPlate: loadPrompt('vision-plate').sha256 },
    });
  });
});
