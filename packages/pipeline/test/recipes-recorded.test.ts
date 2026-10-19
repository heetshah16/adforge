import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { DirectorVariant } from '@adforge/core/llm/schemas';
import { recipeKey, type Recipe } from '@adforge/core/recipe/index';
import { assets, jobs, recipes, variants } from '@adforge/db/schema';
import { findRecipe, recordRecipe } from '../src/record';
import { generateAds } from '../src/orchestrate';
import { makeDeps, memoStep, newJob } from './fakes';

let close: (() => Promise<void>) | undefined;
afterEach(async () => { await close?.(); close = undefined; });

const ASSET_KIND = { plate: 'plate', cutout: 'cutout', broll: 'broll', tts: 'voice' } as const;

describe('recipes recorded by generateAds', () => {
  it('one recipe per generated asset, keyed by recipeKey, output_key the stored key; a second identical run inserts no duplicates', async () => {
    const m = await makeDeps(); close = m.close;
    const { db } = m.deps;
    const id = await newJob(m.deps, true);
    expect((await generateAds(id, memoStep(m.deps), m.deps)).status).toBe('completed');
    const [job] = await db.select().from(jobs).where(eq(jobs.id, id));

    const first = await db.select().from(recipes);
    const of = (rows: typeof first, k: string) => rows.filter((r) => r.kind === k);
    const vs = (await db.select().from(variants).where(eq(variants.jobId, id))).map((v) => v.direction as DirectorVariant);
    const beats = vs.reduce((n, v) => n + v.scenes.length, 0);
    const brolls = vs.filter((v) => v.scenes.some((s) => s.product_prominence === 'absent')).length;
    expect(brolls).toBeGreaterThan(0);
    expect([of(first, 'plate').length, of(first, 'cutout').length, of(first, 'broll').length, of(first, 'tts').length, of(first, 'align').length])
      .toEqual([beats, 1, brolls, beats, beats]);
    expect(first).toHaveLength(beats * 3 + 1 + brolls);

    for (const r of first) {
      const recipe = r.recipe as Recipe;
      expect(r.key).toBe(recipeKey(recipe));
      expect([r.orgId, recipe.orgId]).toEqual([job!.orgId, job!.orgId]);
      expect(recipe.kind).toBe(r.kind);
      expect(recipe.request).not.toHaveProperty('idempotencyKey');
    }
    // Comfy kinds are versioned by workflow hash; media inputs are storage keys, never MediaRefs.
    expect((of(first, 'plate')[0]!.recipe as Recipe)).toMatchObject({ model: 'plate-flux-schnell', version: 'p'.repeat(64) });
    expect(Object.keys((of(first, 'plate')[0]!.recipe as Recipe).request as object).sort()).toEqual(['height', 'prompt', 'width']);
    expect((of(first, 'cutout')[0]!.recipe as Recipe).request).toEqual({ imageKey: expect.stringMatching(/\.png$/) });
    expect((of(first, 'broll')[0]!.recipe as Recipe).request).toMatchObject({ mode: 'image_to_video', imageKey: expect.stringMatching(/\.png$/) });
    expect((of(first, 'broll')[0]!.recipe as Recipe).request).not.toHaveProperty('firstFrame');
    // TTS records exactly what was sent, minus the idempotency key.
    const sent = m.ttsReqs.map(({ idempotencyKey: _, ...req }) => req);
    expect(of(first, 'tts').map((r) => (r.recipe as Recipe).request)).toEqual(expect.arrayContaining(sent));
    expect(Object.keys((of(first, 'align')[0]!.recipe as Recipe).request as object).sort()).toEqual(['audioKey', 'language', 'text']);

    // output_key is the stored asset's key; an alignment's output is its stored words JSON.
    for (const [k, assetKind] of Object.entries(ASSET_KIND)) {
      const stored = (await db.select().from(assets).where(eq(assets.kind, assetKind))).map((a) => a.storageKey).sort();
      expect(of(first, k).map((r) => r.outputKey).sort(), k).toEqual(stored);
    }
    for (const r of of(first, 'align')) {
      expect(JSON.parse(new TextDecoder().decode(await m.deps.storage.read(r.outputKey)))).toEqual({ words: [{ text: 'w', startSec: 0.1, endSec: 0.4 }] });
    }

    // Same inputs again: plate, cutout and TTS recipes hit and keep their first output. B-roll and align take this run's
    // (new, fake) plate and audio keys as inputs, so they are new recipes, one each.
    m.calls.llm = 0; // the fake LLM answers its first call with the brief
    const id2 = await newJob(m.deps, true);
    expect((await generateAds(id2, memoStep(m.deps), m.deps)).status).toBe('completed');
    const second = await db.select().from(recipes);
    for (const k of ['plate', 'cutout', 'tts']) expect(of(second, k), k).toEqual(of(first, k));
    expect(second).toHaveLength(first.length + brolls + beats);
  });
});

describe('recordRecipe / findRecipe', () => {
  it('records once per key (first output wins), returns the key, and finds it in its org only; a miss is null', async () => {
    const m = await makeDeps(); close = m.close;
    const id = await newJob(m.deps);
    const [job] = await m.deps.db.select().from(jobs).where(eq(jobs.id, id));
    const r: Recipe = { kind: 'cutout', provider: 'fake', model: 'cutout-birefnet', version: 'c'.repeat(64), request: { imageKey: 'k' }, orgId: job!.orgId };
    expect(await recordRecipe(m.deps.db, r, 'out-1')).toBe(recipeKey(r));
    expect(await recordRecipe(m.deps.db, r, 'out-2')).toBe(recipeKey(r));
    expect(await findRecipe(m.deps.db, job!.orgId, recipeKey(r))).toEqual({ outputKey: 'out-1' });
    expect(await findRecipe(m.deps.db, job!.orgId, '0'.repeat(64))).toBeNull();
    expect(await findRecipe(m.deps.db, '00000000-0000-4000-8000-00000000000b', recipeKey(r))).toBeNull(); // another org never hits
  });
});
