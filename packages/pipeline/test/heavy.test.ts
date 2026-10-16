import { afterEach, describe, expect, it } from 'vitest';
import { providerCalls } from '@adforge/db/schema';
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
    const r = await HEAVY.voice(m.deps, { jobId: await jobRow(m.deps), language: 'en', variants: anchor().variants });
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
});
