import { afterEach, describe, expect, it } from 'vitest';
import { PIPELINE } from '@adforge/core/config/pipeline';
import { ProviderError } from '@adforge/core/providers/types';
import { eq, sql } from 'drizzle-orm';
import { libraryAssets, providerCalls } from '@adforge/db/schema';
import { seedOperator } from '@adforge/db/seed/seed';
import { HEAVY } from '../src/heavy';
import type { PipelineDeps } from '../src/types';
import { anchor, jobRow, makeDeps } from './fakes';

let close: (() => Promise<void>) | undefined;
afterEach(async () => { await close?.(); close = undefined; });

/** Every beat → the same real stored plate (b-roll reads its first frame from storage). */
async function storedPlates(deps: PipelineDeps) {
  const plate = await deps.storage.put(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 7]), { mime: 'image/png' });
  return Object.fromEntries(anchor().variants.flatMap((v) => v.scenes.map((_, b) => [`${v.variant_no}:${b}`, plate.id])));
}

describe('heavy tasks', () => {
  it('plates: one plate per beat plus the cutout, recorded, then frees ComfyUI', async () => {
    const m = await makeDeps(); close = m.close;
    const jobId = await jobRow(m.deps);
    const photo = await m.deps.storage.put(new Uint8Array([1, 2, 3]), { mime: 'image/png' });
    const r = await HEAVY.plates(m.deps, { jobId, variants: anchor().variants, photoKey: photo.id });
    expect(Object.keys(r.plates)).toHaveLength(12);
    expect(r.cutout).toMatch(/\.png$/);
    expect(m.calls.free).toBe(1);
    expect(await m.deps.db.$count(providerCalls)).toBe(13);
  });

  it('voice: the active @voice_<brand>_en bible rides on every English TTS request and is attributed; misses warn and use defaults', async () => {
    const m = await makeDeps(); close = m.close;
    const jobId = await jobRow(m.deps);
    const variants = anchor().variants.slice(0, 1);
    // The normal path: no explicit brand and no voice rows in the org -> silent, but recorded.
    const quiet = await HEAVY.voice(m.deps, { jobId, language: 'en', variants, nameBrand: 'Krishna' });
    expect(m.ttsReqs.length).toBeGreaterThan(0);
    expect(m.ttsReqs.every((r) => r.voiceBible === undefined)).toBe(true);
    expect(quiet).toMatchObject({ voiceUsed: 'config-defaults' });
    expect(quiet.warning).toBeUndefined();
    // An explicit brand with no row warns.
    const miss = await HEAVY.voice(m.deps, { jobId: await jobRow(m.deps), language: 'en', variants, brand: 'Krishna' });
    expect(miss).toMatchObject({ voiceUsed: 'config-defaults', warning: 'voice bible @voice_krishna_en not used (no active row), using config defaults' });
    const bible = { engine: 'qwen', speaker: 'Ryan', baseInstruct: 'Warm and unhurried.' };
    await m.deps.db.insert(libraryAssets).values({ ...(await seedOperator(m.deps.db)), tag: '@voice_krishna_en', version: 1, kind: 'voice', descriptor: 'd', meta: bible });
    m.ttsReqs.length = 0;
    const used = await HEAVY.voice(m.deps, { jobId: await jobRow(m.deps), language: 'en', variants, nameBrand: 'Krishna' });
    expect(m.ttsReqs.every((r) => r.voiceBible?.speaker === 'Ryan' && r.voiceBible.baseInstruct === bible.baseInstruct)).toBe(true);
    expect(used.voiceUsed).toBe('@voice_krishna_en_v1');
    expect(used.warning).toBeUndefined();
    const rows = await m.deps.db.select().from(providerCalls).where(eq(providerCalls.kind, 'tts'));
    expect(rows.filter((r) => r.model === '@voice_krishna_en_v1').length).toBeGreaterThan(0);
    expect(rows.some((r) => r.model === 'config-defaults')).toBe(true);
    // The org now has a voice row, so a name-derived miss ("The Krishna Hing" -> "the") is unexpected and warns.
    const the = await HEAVY.voice(m.deps, { jobId: await jobRow(m.deps), language: 'en', variants, nameBrand: 'The' });
    expect(the.warning).toContain('@voice_the_en not used');
    const odd = await HEAVY.voice(m.deps, { jobId: await jobRow(m.deps), language: 'en', variants, brand: '!!!' });
    expect(odd).toMatchObject({ voiceUsed: 'config-defaults', warning: expect.stringContaining('not used') });
    // An unusable row warns too.
    await m.deps.db.insert(libraryAssets).values({ ...(await seedOperator(m.deps.db)), tag: '@voice_bad_en', version: 1, kind: 'voice', descriptor: 'd', meta: { engine: 'chatterbox' } });
    const bad = await HEAVY.voice(m.deps, { jobId: await jobRow(m.deps), language: 'en', variants, nameBrand: 'Bad' });
    expect(bad.warning).toContain('not qwen');
  });

  it('voice: an unusable bible row (bad speaker, over-long baseInstruct) falls back with a warning; never fails the beats', async () => {
    const m = await makeDeps(); close = m.close;
    const variants = anchor().variants.slice(0, 1);
    const q = PIPELINE.voice.qwen;
    const longest = Math.max(q.calmInstruct.length, q.expressiveInstruct.length);
    const ins = async (brand: string, meta: Record<string, unknown>) =>
      m.deps.db.insert(libraryAssets).values({ ...(await seedOperator(m.deps.db)), tag: `@voice_${brand}_en`, version: 1, kind: 'voice', descriptor: 'd', meta });
    await ins('spk', { engine: 'qwen', speaker: 'Nobody', baseInstruct: 'Warm.' });
    await ins('long', { engine: 'qwen', speaker: 'Ryan', baseInstruct: 'x'.repeat(300 - longest) }); // base + ' ' + beat = 301
    await ins('edge', { engine: 'qwen', speaker: 'Ryan', baseInstruct: 'x'.repeat(299 - longest) }); // exactly 300: usable
    const run = async (nameBrand: string) => HEAVY.voice(m.deps, { jobId: await jobRow(m.deps), language: 'en', variants, nameBrand });
    expect(await run('Spk')).toMatchObject({ voiceUsed: 'config-defaults', warning: expect.stringContaining('not a Qwen speaker') });
    const long = await run('Long');
    expect(long).toMatchObject({ voiceUsed: 'config-defaults', warning: expect.stringContaining('too long') });
    expect(Object.values(long.beats).every(Boolean)).toBe(true);
    expect(m.ttsReqs.some((r) => r.voiceBible?.baseInstruct.startsWith('xxx') && r.voiceBible.baseInstruct.length === 300 - longest)).toBe(false);
    expect(await run('Edge')).toMatchObject({ voiceUsed: '@voice_edge_en_v1' });
  });

  it('voice: a bible is not used (nor attributed) when English is not on qwen', async () => {
    const m = await makeDeps(); close = m.close;
    await m.deps.db.insert(libraryAssets).values({ ...(await seedOperator(m.deps.db)), tag: '@voice_krishna_en', version: 1, kind: 'voice', descriptor: 'd', meta: { engine: 'qwen', speaker: 'Ryan', baseInstruct: 'Warm.' } });
    const en = PIPELINE.voice.engineByLanguage;
    const was = en.en;
    en.en = 'chatterbox';
    try {
      const r = await HEAVY.voice(m.deps, { jobId: await jobRow(m.deps), language: 'en', variants: anchor().variants.slice(0, 1), nameBrand: 'Krishna' });
      expect(r.voiceUsed).toBe('config-defaults');
      expect(m.ttsReqs.every((x) => x.voiceBible === undefined)).toBe(true);
    } finally { en.en = was; }
  });

  it('voice: a throwing bible lookup falls back with a warning and never fails the step', async () => {
    const m = await makeDeps(); close = m.close;
    const jobId = await jobRow(m.deps);
    const real = m.deps.db.select.bind(m.deps.db);
    let n = 0;
    // jobScope's select (1st) works; the library lookup (2nd) throws.
    (m.deps.db as { select: unknown }).select = ((...a: unknown[]) => { if (++n === 2) throw new Error('db blew up'); return (real as (...x: unknown[]) => unknown)(...a); }) as never;
    const r = await HEAVY.voice(m.deps, { jobId, language: 'en', variants: anchor().variants.slice(0, 1), brand: 'Krishna' });
    expect(r.warning).toContain('lookup failed: db blew up');
    expect(r.voiceUsed).toBe('config-defaults');
    expect(Object.values(r.beats).filter(Boolean).length).toBeGreaterThan(0);
  });

  it('plateVision: luma + depth per plate, recorded, vision unloaded even when a plate fails', async () => {
    const m = await makeDeps({ depthDown: true }); close = m.close;
    const jobId = await jobRow(m.deps);
    const plate = await m.deps.storage.put(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 9]), { mime: 'image/png' });
    const r = await HEAVY.plateVision(m.deps, { jobId, plateKeys: [plate.id] });
    expect(r[plate.id]).toMatchObject({ error: expect.any(String) });
    expect(m.calls.visionUnload).toBe(1);
  });

  it('broll: one clip per variant on its first absent beat, and a failed poll re-submits once', async () => {
    const ok = await makeDeps(); close = ok.close;
    const variants = anchor().variants;
    const r = await HEAVY.broll(ok.deps, { jobId: await jobRow(ok.deps), variants, plates: await storedPlates(ok.deps) });
    expect(r['1']).toMatchObject({ beat: 0 }); // problem_solution: beat 0 is absent
    expect(ok.calls.free).toBe(1);
    await ok.close();
    const bad = await makeDeps({ failBroll: true }); close = bad.close;
    const r2 = await HEAVY.broll(bad.deps, { jobId: await jobRow(bad.deps), variants, plates: await storedPlates(bad.deps) });
    expect(r2['1']).toBeNull();
    expect(bad.calls.videoSubmit).toBe(6); // 3 variants × (submit + one re-submit)
  });

  it('voice: every beat voiced and aligned, then unloads the voice service', async () => {
    const m = await makeDeps(); close = m.close;
    const { beats: r } = await HEAVY.voice(m.deps, { jobId: await jobRow(m.deps), language: 'en', variants: anchor().variants });
    expect(Object.values(r).filter(Boolean)).toHaveLength(12);
    expect(r['1:0']!.words[0]).toMatchObject({ text: 'Nobody' }); // script words, ASR timing
    expect(m.calls.unload).toBe(1);
  });

  it('voice: waits (bounded) for ComfyUI VRAM to drop before loading TTS', async () => {
    const m = await makeDeps(); close = m.close;
    const used = [14e9, 12e9, 2e9];
    m.deps.comfy.systemStats = async () => ({ vramUsedBytes: used.shift() ?? 2e9, vramTotalBytes: 16e9 });
    let slept = 0;
    m.deps.sleep = async () => { slept++; };
    await HEAVY.voice(m.deps, { jobId: await jobRow(m.deps), language: 'en', variants: anchor().variants });
    expect(slept).toBe(2); // two polls above half of total, then proceeds
  });

  it('plates: a mid-way throw still frees ComfyUI', async () => {
    const m = await makeDeps(); close = m.close;
    m.deps.comfy.image.generate = async () => { throw new Error('boom'); };
    const photo = await m.deps.storage.put(new Uint8Array([1]), { mime: 'image/png' });
    await expect(HEAVY.plates(m.deps, { jobId: await jobRow(m.deps), variants: anchor().variants, photoKey: photo.id })).rejects.toThrow('boom');
    expect(m.calls.free).toBe(1);
  });

  it('plates: one failed plate is null and the rest continue', async () => {
    const m = await makeDeps(); close = m.close;
    const gen = m.deps.comfy.image.generate;
    let n = 0;
    m.deps.comfy.image.generate = async (r) => (n++ === 1 ? { status: 'failed', error: new ProviderError('fake', 'UPSTREAM', 'x'), retryable: true } : gen(r));
    const photo = await m.deps.storage.put(new Uint8Array([1]), { mime: 'image/png' });
    const r = await HEAVY.plates(m.deps, { jobId: await jobRow(m.deps), variants: anchor().variants, photoKey: photo.id });
    expect(Object.values(r.plates).filter((x) => x === null)).toHaveLength(1);
    expect(Object.values(r.plates).filter(Boolean)).toHaveLength(11);
  });

  it('voice: a mid-way throw still unloads', async () => {
    const m = await makeDeps(); close = m.close;
    m.deps.voice.tts.synthesize = async () => { throw new Error('boom'); };
    await expect(HEAVY.voice(m.deps, { jobId: await jobRow(m.deps), language: 'en', variants: anchor().variants })).rejects.toThrow('boom');
    expect(m.calls.unload).toBe(1);
  });

  it('voice: systemStats rejecting proceeds without sleeping', async () => {
    const m = await makeDeps(); close = m.close;
    m.deps.comfy.systemStats = async () => { throw new Error('down'); };
    let slept = 0;
    m.deps.sleep = async () => { slept++; };
    const { beats: r } = await HEAVY.voice(m.deps, { jobId: await jobRow(m.deps), language: 'en', variants: anchor().variants });
    expect(slept).toBe(0);
    expect(Object.values(r).filter(Boolean)).toHaveLength(12);
  });

  it('voice: VRAM never dropping stops after the 20-poll cap', async () => {
    const m = await makeDeps(); close = m.close;
    m.deps.comfy.systemStats = async () => ({ vramUsedBytes: 15e9, vramTotalBytes: 16e9 });
    let slept = 0;
    m.deps.sleep = async () => { slept++; };
    const { beats: r } = await HEAVY.voice(m.deps, { jobId: await jobRow(m.deps), language: 'en', variants: anchor().variants });
    expect(slept).toBe(20);
    expect(Object.values(r).filter(Boolean)).toHaveLength(12);
  });

  it('voice: a TTS failure on one beat is null and the others continue', async () => {
    const m = await makeDeps(); close = m.close;
    const syn = m.deps.voice.tts.synthesize;
    let n = 0;
    m.deps.voice.tts.synthesize = async (r) => (n++ === 0 ? { status: 'failed', error: new ProviderError('fake', 'UPSTREAM', 'x'), retryable: true } : syn(r));
    const { beats: r } = await HEAVY.voice(m.deps, { jobId: await jobRow(m.deps), language: 'en', variants: anchor().variants });
    expect(r['1:0']).toBeNull();
    expect(Object.values(r).filter(Boolean)).toHaveLength(11);
  });

  it('broll: a non-retryable failure submits exactly once per variant', async () => {
    const m = await makeDeps(); close = m.close;
    m.deps.comfy.video.poll = async () => ({ status: 'failed', error: new ProviderError('fake', 'INVALID_INPUT', 'x'), retryable: false });
    const r = await HEAVY.broll(m.deps, { jobId: await jobRow(m.deps), variants: anchor().variants, plates: await storedPlates(m.deps) });
    expect(r['1']).toBeNull();
    expect(m.calls.videoSubmit).toBe(3);
  });

  it('broll: the re-submit reuses the same idempotency key', async () => {
    const m = await makeDeps({ failBroll: true }); close = m.close;
    const keys: string[] = [];
    const submit = m.deps.comfy.video.submit;
    m.deps.comfy.video.submit = async (r) => { keys.push(r.idempotencyKey); return submit(r); };
    const jobId = await jobRow(m.deps);
    await HEAVY.broll(m.deps, { jobId, variants: anchor().variants.slice(0, 1), plates: await storedPlates(m.deps) });
    expect(keys).toEqual([`${jobId}:broll:1`, `${jobId}:broll:1`]);
  });

  it('broll: pending until the deadline re-submits once, then degrades to null without throwing', async () => {
    const m = await makeDeps(); close = m.close;
    m.deps.comfy.video.submit = async (r) => { m.calls.videoSubmit++; return { provider: 'fake', externalId: r.idempotencyKey, pollAfterMs: PIPELINE.broll.pollDeadlineMs / 2 }; };
    m.deps.comfy.video.poll = async (handle) => ({ status: 'pending', handle });
    const r = await HEAVY.broll(m.deps, { jobId: await jobRow(m.deps), variants: anchor().variants.slice(0, 1), plates: await storedPlates(m.deps) });
    expect(r['1']).toBeNull();
    expect(m.calls.videoSubmit).toBe(2);
    expect(m.calls.free).toBe(1);
  });

  it('broll: a failed recipe write is not swallowed as "b-roll unavailable": the step throws (and retries), ComfyUI still freed', async () => {
    const m = await makeDeps(); close = m.close;
    await m.deps.db.execute(sql`alter table recipes rename to recipes_gone`);
    await expect(HEAVY.broll(m.deps, { jobId: await jobRow(m.deps), variants: anchor().variants.slice(0, 1), plates: await storedPlates(m.deps) })).rejects.toThrow();
    expect(m.calls.free).toBe(1);
  });

  it('broll: a throwing submit nulls that variant, the others continue, and ComfyUI is freed', async () => {
    const m = await makeDeps(); close = m.close;
    const submit = m.deps.comfy.video.submit;
    m.deps.comfy.video.submit = async (r) => { if (r.idempotencyKey.endsWith(':1')) throw new Error('boom'); return submit(r); };
    const r = await HEAVY.broll(m.deps, { jobId: await jobRow(m.deps), variants: anchor().variants, plates: await storedPlates(m.deps) });
    expect(r['1']).toBeNull();
    expect(r['2'] ?? r['3']).toBeTruthy();
    expect(m.calls.free).toBe(1);
  });

  it('render: a throwing renderer yields { error }, not a rejection', async () => {
    const m = await makeDeps(); close = m.close;
    m.deps.renderer.render = async () => { throw new Error('chrome died'); };
    const r = await HEAVY.render(m.deps, { jobId: await jobRow(m.deps), variantNo: 1, spec: {} as never });
    expect(r).toEqual({ error: 'chrome died' });
  });
});
