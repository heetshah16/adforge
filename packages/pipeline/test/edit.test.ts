import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { EditOp } from '@adforge/core/project';
import { orgs, projects, providerCalls, variantRevisions, variants } from '@adforge/db/schema';
import { editVariant, exportRevision } from '../src/edit';
import { generateAds } from '../src/orchestrate';
import { makeDeps, type FakeControls, memoStep, newJob } from './fakes';

let close: (() => Promise<void>) | undefined;
afterEach(async () => { await close?.(); close = undefined; });

type M = Awaited<ReturnType<typeof makeDeps>>;
const UNLOCK: EditOp = { op: 'unlock' };
const LONG = 'A much longer replacement line for the second beat of this ad';

async function generated(m: M, scope?: Parameters<typeof newJob>[2], broll = false, variantNo = 1) {
  const jobId = await newJob(m.deps, broll, scope);
  await generateAds(jobId, memoStep(m.deps), m.deps);
  const [variant] = await m.deps.db.select().from(variants).where(and(eq(variants.jobId, jobId), eq(variants.variantNo, variantNo)));
  const [rev0] = await m.deps.db.select().from(variantRevisions).where(eq(variantRevisions.variantId, variant!.id));
  return { jobId, variant: variant!, rev0: rev0! };
}
type G = Awaited<ReturnType<typeof generated>>;

/** What the revision route inserts: a pending child holding its parent's beats. */
async function child(m: M, g: G, ops: EditOp[]) {
  const [r] = await m.deps.db.insert(variantRevisions).values({ orgId: g.variant.orgId, variantId: g.variant.id, parentId: g.rev0.id, ops, beats: g.rev0.beats, status: 'pending', locked: false }).returning();
  return r!;
}
const load = async (m: M, id: string) => (await m.deps.db.select().from(variantRevisions).where(eq(variantRevisions.id, id)))[0]!;
const snap = (m: M) => ({ ...m.calls });
const run = (m: M, id: string) => editVariant(id, memoStep(m.deps), m.deps);

describe('variant.edit executor', () => {
  it('free ops make no provider calls and the spec reflects them', async () => {
    const m = await makeDeps(); close = m.close;
    const g = await generated(m);
    const r = await child(m, g, [UNLOCK, { op: 'move', layerId: 's1.headline', x: 0.1, y: 0.3 }, { op: 'setStyle', layerId: 'captions', style: { weight: 'regular' } }, { op: 'setText', layerId: 's0.headline', content: 'Edited' }, { op: 'retime', layerId: 's1.headline', reveal: { kind: 'scene', offsetFrames: 5 } }]);
    const before = snap(m);
    await run(m, r.id);
    expect([m.calls.tts - before.tts, m.calls.align - before.align, m.calls.image - before.image]).toEqual([0, 0, 0]);
    const out = await load(m, r.id);
    expect(out.status).toBe('ready');
    const spec = out.spec as { scenes: { startFrame: number; layers: { layerId: string; content?: string; revealFrame: number; box: { x: number; y: number } }[] }[]; captions: { style: { weight: string } } };
    expect(spec.scenes[0]!.layers.find((l) => l.layerId === 's0.headline')!.content).toBe('Edited');
    expect(spec.scenes[1]!.layers.find((l) => l.layerId === 's1.headline')!.box).toMatchObject({ x: 0.1, y: 0.3 });
    expect(spec.captions.style.weight).toBe('regular');
    expect(spec.scenes[1]!.layers.find((l) => l.layerId === 's1.headline')!.revealFrame).toBe(spec.scenes[1]!.startFrame + 5);
    expect(out.error).toBeNull();
  });

  it('one VO edit: 1 tts + 1 align, no image; later scenes shift and the word-cued reveal follows; the same edit again is a cache hit', async () => {
    const m = await makeDeps({ ttsSec: (r) => (r.text === LONG ? 12 : 3) }); close = m.close;
    const g = await generated(m);
    const ops: EditOp[] = [UNLOCK, { op: 'setField', beat: 1, path: 'vo', value: LONG }, { op: 'retime', layerId: 's1.headline', reveal: { kind: 'word', word: 0, offsetFrames: 0 } }];
    const r = await child(m, g, ops);
    const before = snap(m);
    await run(m, r.id);
    expect([m.calls.tts - before.tts, m.calls.align - before.align, m.calls.image - before.image]).toEqual([1, 1, 0]);
    const out = await load(m, r.id);
    type S = { scenes: { startFrame: number; layers: { layerId: string; revealFrame: number }[] }[]; audio: { voice: { key: string }[] }; captions: { words: { startFrame: number }[] } };
    const a = g.rev0.spec as S, b = out.spec as S;
    expect(b.audio.voice[1]!.key).not.toBe(a.audio.voice[1]!.key);
    expect(b.audio.voice[0]!.key).toBe(a.audio.voice[0]!.key);
    expect(b.scenes[2]!.startFrame).toBeGreaterThan(a.scenes[2]!.startFrame);
    const s1 = b.scenes[1]!, s2 = b.scenes[2]!;
    const firstWord = b.captions.words.find((w) => w.startFrame >= s1.startFrame && w.startFrame < s2.startFrame)!;
    expect(s1.layers.find((l) => l.layerId === 's1.headline')!.revealFrame).toBe(firstWord.startFrame);

    const again = await child(m, g, ops);
    const mid = snap(m);
    await run(m, again.id);
    expect([m.calls.tts - mid.tts, m.calls.align - mid.align, m.calls.image - mid.image]).toEqual([0, 0, 0]);
    expect((await load(m, again.id)).spec).toEqual(out.spec);
  });

  it('the same VO text in another org calls the provider again', async () => {
    const m = await makeDeps(); close = m.close;
    const a = await generated(m);
    const orgId = randomUUID();
    await m.deps.db.insert(orgs).values({ id: orgId, name: 'Tenant B' });
    const [p] = await m.deps.db.insert(projects).values({ orgId, userId: m.op.userId, name: 'B' }).returning();
    m.calls.llm = 0; // the fake LLM serves the brief on its first call
    const b = await generated(m, { orgId, projectId: p!.id, userId: m.op.userId });
    const ops: EditOp[] = [UNLOCK, { op: 'setField', beat: 1, path: 'vo', value: LONG }];
    await run(m, (await child(m, a, ops)).id);
    const before = snap(m);
    await run(m, (await child(m, b, ops)).id);
    expect([m.calls.tts - before.tts, m.calls.align - before.align]).toEqual([1, 1]);
  });

  it('a retry after the TTS succeeded makes no second TTS call', async () => {
    const ctl: FakeControls = {};
    const m = await makeDeps(ctl); close = m.close;
    const g = await generated(m);
    ctl.alignThrows = 1;
    const r = await child(m, g, [UNLOCK, { op: 'setField', beat: 1, path: 'vo', value: LONG }]);
    const before = snap(m);
    await expect(run(m, r.id)).rejects.toThrow();
    await run(m, r.id); // fresh step cache: the step bodies run again
    expect(m.calls.tts - before.tts).toBe(1);
    expect((await load(m, r.id)).status).toBe('ready');
    const keys = (await m.deps.db.select({ k: providerCalls.idempotencyKey }).from(providerCalls)).map((x) => x.k);
    expect(keys.filter((k) => k === `${r.id}:tts:1`)).toHaveLength(1);
    expect(keys.filter((k) => k === `${r.id}:align:1`)).toHaveLength(1);
  });

  it('regenerate voice re-synthesizes; a scene edit regenerates the plate once, under its idempotency key', async () => {
    const m = await makeDeps(); close = m.close;
    const g = await generated(m);
    const rv = await child(m, g, [UNLOCK, { op: 'regenerate', assetTag: 'voice:0' }]);
    const b0 = snap(m);
    await run(m, rv.id);
    expect([m.calls.tts - b0.tts, m.calls.align - b0.align, m.calls.image - b0.image]).toEqual([1, 1, 0]);

    const rp = await child(m, g, [UNLOCK, { op: 'setField', beat: 1, path: 'scene', value: 'on a marble counter' }]);
    const b1 = snap(m);
    await run(m, rp.id);
    expect([m.calls.tts - b1.tts, m.calls.image - b1.image]).toEqual([0, 1]);
    const key = (r: { spec: unknown }) => (r.spec as { scenes: { layers: { type: string; key?: string }[] }[] }).scenes[1]!.layers.find((l) => l.type === 'plate' || l.type === 'broll')!.key;
    expect(key(await load(m, rp.id))).not.toBe(key(g.rev0));
    const calls = await m.deps.db.select().from(providerCalls).where(eq(providerCalls.idempotencyKey, `${rp.id}:plate:1`));
    expect(calls).toHaveLength(1);
  });

  it('an op on a missing layer is dropped: the revision is ready and error lists it', async () => {
    const m = await makeDeps(); close = m.close;
    const g = await generated(m);
    const gone: EditOp = { op: 'move', layerId: 's9.headline', x: 0.1, y: 0.2 };
    const r = await child(m, g, [UNLOCK, gone]);
    await run(m, r.id);
    const out = await load(m, r.id);
    expect(out.status).toBe('ready');
    expect(out.error).toEqual({ dropped: [{ op: gone, reason: 'missing_target' }] });
  });

  it('a deterministic failure (structural op) marks the revision failed', async () => {
    const m = await makeDeps(); close = m.close;
    const g = await generated(m);
    const r = await child(m, g, [UNLOCK, { op: 'setField', beat: 0, path: 'format', value: 'x' }]);
    await run(m, r.id);
    const out = await load(m, r.id);
    expect(out.status).toBe('failed');
    expect(out.error).toMatchObject({ message: expect.stringContaining('structural') });
  });
});

describe('variant.edit failures and b-roll', () => {
  const rows = (m: M, key: string) => m.deps.db.select().from(providerCalls).where(eq(providerCalls.idempotencyKey, key));

  it('a retryable provider failure throws; the retry succeeds with exactly one successful call recorded', async () => {
    const ctl: FakeControls = {};
    const m = await makeDeps(ctl); close = m.close;
    const g = await generated(m);
    ctl.ttsFail = { retryable: true, times: 1 };
    const r = await child(m, g, [UNLOCK, { op: 'setField', beat: 1, path: 'vo', value: LONG }]);
    await expect(run(m, r.id)).rejects.toThrow();
    expect((await load(m, r.id)).status).toBe('pending');
    await run(m, r.id);
    expect((await load(m, r.id)).status).toBe('ready');
    const calls = await rows(m, `${r.id}:tts:1`);
    expect(calls.map((c) => c.status)).toEqual(['done']);
    expect(calls[0]!.model).toBe('config-defaults'); // like generateAds: the voice used
  });

  it('a non-retryable provider failure fails the revision without throwing', async () => {
    const ctl: FakeControls = {};
    const m = await makeDeps(ctl); close = m.close;
    const g = await generated(m);
    ctl.ttsFail = { retryable: false, times: 5 };
    const r = await child(m, g, [UNLOCK, { op: 'setField', beat: 1, path: 'vo', value: LONG }]);
    const before = m.calls.tts;
    await run(m, r.id);
    const out = await load(m, r.id);
    expect(out.status).toBe('failed');
    expect(out.error).toMatchObject({ message: expect.stringContaining('tts failed') });
    expect(m.calls.tts - before).toBe(1);
  });

  it('a scene edit on the b-roll beat drops the clip: no broll in beats, a plate layer in the spec', async () => {
    const m = await makeDeps(); close = m.close;
    let g: G | undefined; let b = -1;
    for (const n of [1, 2, 3]) {
      g = await generated(m, undefined, true, n);
      b = (g.rev0.beats as { broll?: unknown }[]).findIndex((x) => x.broll);
      if (b >= 0) break;
    }
    expect(b).toBeGreaterThanOrEqual(0);
    const r = await child(m, g!, [UNLOCK, { op: 'setField', beat: b, path: 'scene', value: 'on a marble counter' }]);
    await run(m, r.id);
    const out = await load(m, r.id);
    expect(out.status).toBe('ready');
    expect((out.beats as { broll?: unknown }[])[b]!.broll).toBeUndefined();
    const layers = (out.spec as { scenes: { layers: { layerId: string }[] }[] }).scenes[b]!.layers.map((l) => l.layerId);
    expect(layers).toContain(`s${b}.plate`);
    expect(layers).not.toContain(`s${b}.broll`);
  });
});

describe('variant.export', () => {
  it('renders a ready revision once and sets render_asset_id; a second event renders nothing', async () => {
    const m = await makeDeps(); close = m.close;
    const g = await generated(m);
    const r = await child(m, g, [UNLOCK, { op: 'move', layerId: 's1.headline', x: 0.1, y: 0.3 }]);
    await run(m, r.id);
    const before = m.calls.render;
    await exportRevision(r.id, memoStep(m.deps), m.deps);
    expect(m.calls.render - before).toBe(1);
    const out = await load(m, r.id);
    expect(out.renderAssetId).toBeTruthy();
    const rk = await m.deps.db.select().from(providerCalls).where(eq(providerCalls.idempotencyKey, `${r.id}:render`));
    expect(rk).toHaveLength(1);
    await exportRevision(r.id, memoStep(m.deps), m.deps);
    expect(m.calls.render - before).toBe(1);
  });

  it('refuses a revision that is not ready', async () => {
    const m = await makeDeps(); close = m.close;
    const g = await generated(m);
    const r = await child(m, g, [UNLOCK, { op: 'move', layerId: 's1.headline', x: 0.1, y: 0.3 }]);
    const before = m.calls.render;
    await exportRevision(r.id, memoStep(m.deps), m.deps);
    expect(m.calls.render - before).toBe(0);
    expect((await load(m, r.id)).renderAssetId).toBeNull();
  });
});
