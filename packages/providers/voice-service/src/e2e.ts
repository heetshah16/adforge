import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, parseEnv } from '@adforge/core/config/env';
import { TREATMENTS } from '@adforge/core/config/treatments';
import { loadPrompt } from '@adforge/core/llm/prompts';
import type { DirectorOutput, DirectorVariant } from '@adforge/core/llm/schemas';
import { Language, Motion, ProductProminence, VisualTreatment } from '@adforge/core/vocab/enums';
import { z } from 'zod';
import type { MediaRef, ProviderResult } from '@adforge/core/providers/types';
import { ttsText } from '@adforge/core/llm/tts-text';
import { alignCaptions } from '@adforge/core/spec/align-captions';
import { buildSpec, type BeatAssets } from '@adforge/core/spec/build-spec';
import { createComfyProviders } from '@adforge/provider-comfyui';
import { LocalDiskStorage } from '@adforge/provider-local-storage';
import { HyperframesRenderer } from '@adforge/renderer-hyperframes';
import { createVoiceProviders } from './providers';

/**
 * P6 end-to-end. Voices variant 1 of each saved Director direction (<data>/e2e/directions/*.json, written by the P5 e2e);
 * with none saved, falls back to the anchor variant in en / hi / hinglish. Output: rendered MP4s for the listening check.
 */
try {
  process.loadEnvFile(join(REPO_ROOT, '.env'));
} catch (e) {
if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
}
const env = parseEnv(process.env);
const storage = new LocalDiskStorage(join(env.ADFORGE_DATA_DIR, 'media'), env.ADFORGE_PUBLIC_URL);
const comfy = createComfyProviders({
baseUrl: env.COMFYUI_URL, storage,
plateWorkflow: env.ADFORGE_COMFY_WORKFLOW_PLATE, cutoutWorkflow: env.ADFORGE_COMFY_WORKFLOW_CUTOUT, brollWorkflow: env.ADFORGE_COMFY_WORKFLOW_BROLL,
});
const voice = createVoiceProviders({ baseUrl: env.ADFORGE_VOICE_URL, storage });
const renderer = new HyperframesRenderer({ storage, workDir: join(env.ADFORGE_DATA_DIR, 'render-work') });
const done = <T>(step: string, r: ProviderResult<T>): T => {
if (r.status !== 'done') { throw new Error(`FAIL ${step}: ${r.status === 'failed' ? `${r.error.code} ${r.error.message}` : 'pending'}`); }
return r.value;
};

const t = loadPrompt('director').text;
const base = (JSON.parse(t.slice(t.indexOf('```json') + 7, t.lastIndexOf('```'))) as DirectorOutput).variants[0]!;
const VO: Record<'hi' | 'hinglish', string[]> = {
hi: [
  'कोई नहीं बताता कि आपका खाने का तेल कैसे बनता है।',
  'ज़्यादातर तेल केमिकल सॉल्वेंट से निकाला जाता है, फिर ब्लीच होता है।',
  'यह तेल लकड़ी की घानी में ठंडा पेरा गया है। बस इतना ही।',
  'वही रसोई। एक ईमानदार बोतल।',
],
hinglish: [
  'Koi nahi batata ki aapka cooking oil kaise banta hai.',
  'Zyaadatar oil chemical solvent se nikaalte hain, phir bleach karte hain.',
  'Yeh oil lakdi ki ghani mein thanda pressa gaya hai. Bas.',
  'Wahi kitchen. Ek imaandaar bottle.',
],
};
interface Item { slug: string; variant: DirectorVariant }
const dirsPath = join(env.ADFORGE_DATA_DIR, 'e2e', 'directions');
const saved = existsSync(dirsPath) ? readdirSync(dirsPath).filter((f) => f.endsWith('.json')) : [];
// Only the fields this script reads are checked; the rest passes through untouched.
const SavedDirection = z.object({
slug: z.string().min(1),
language: Language,
output: z.object({
  variants: z.array(z.looseObject({
    visual_treatment: VisualTreatment,
    scenes: z.array(z.looseObject({
      vo: z.string().min(1), vo_tts: z.string().min(1).optional(), scene: z.string().min(1),
      product_prominence: ProductProminence, duration: z.number().positive(), motion: Motion, emotion: z.number().min(0).max(1),
    })).min(1),
  })).min(1),
}),
});
const items: Item[] = [];
for (const f of saved) {
const r = SavedDirection.safeParse(JSON.parse(readFileSync(join(dirsPath, f), 'utf8')));
if (!r.success) { console.warn(`skipping ${f}: ${z.prettifyError(r.error)}`); continue; }
items.push({ slug: r.data.slug, variant: { ...(r.data.output.variants[0] as unknown as DirectorVariant), language: r.data.language } });
}
if (items.length === 0) {
items.push(
  { slug: 'anchor-en', variant: base },
  { slug: 'anchor-hi', variant: { ...base, language: 'hi', scenes: base.scenes.map((s, i) => ({ ...s, vo: VO.hi[i]! })) } },
  { slug: 'anchor-hinglish', variant: { ...base, language: 'hinglish', scenes: base.scenes.map((s, i) => ({ ...s, vo: VO.hinglish[i]!, vo_tts: VO.hi[i]! })) } },
);
}
console.log('voicing:', items.map((i) => `${i.slug}(${i.variant.language})`).join(', '));

try {
await comfy.preflight();
console.log('voice health:', await voice.health());

  const assets: BeatAssets[][] = [];
  // Batch 1 — ComfyUI: each variant's own plates + one product cutout.
  const plates: MediaRef[][] = [];
  for (const { slug, variant } of items) {
    const suffix = TREATMENTS[variant.visual_treatment].platePromptSuffix;
    const ps: MediaRef[] = [];
    for (const [i, s] of variant.scenes.entries()) {
      ps.push(done(`plate ${slug} ${i + 1}`, await comfy.image.generate({ prompt: `${s.scene}, ${suffix}`, width: 768, height: 1344, idempotencyKey: `p6:${slug}:plate:${i}` })));
    }
    plates.push(ps);
  }
  const product = done('product', await comfy.image.generate({
    prompt: 'studio product photo of a single amber glass bottle with a plain paper label, isolated on a pure white background',
    width: 768, height: 1344, idempotencyKey: 'smoke:p2-check:product',
  }));
  const cutout = done('cutout', await comfy.cutout.cutout({ image: product, idempotencyKey: 'smoke:p2-check:cutout' }));

  // GPU hand-off: free ComfyUI, then wait (<= 20 s) until VRAM in use is under half of total (same heuristic as P7).
  const before = await comfy.systemStats();
  await comfy.free();
  let after = before;
  for (const start = Date.now(); Date.now() - start < 20_000; ) {
    after = await comfy.systemStats();
    if (after.vramUsedBytes < after.vramTotalBytes / 2) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  const gb = (n: number) => (n / 1024 ** 3).toFixed(2);
  console.log(`vram used: ${gb(before.vramUsedBytes)} GB -> ${gb(after.vramUsedBytes)} GB of ${gb(after.vramTotalBytes)} GB`);

  // Batch 2 — voice + alignment. TTS speaks ttsText (Devanagari for hinglish); captions keep the Latin vo.
  for (const [n, { slug, variant: v }] of items.entries()) {
    const beats: BeatAssets[] = [];
    for (const [i, s] of v.scenes.entries()) {
      const t0 = Date.now();
      const text = ttsText(s, v.language);
      const key = `p6:${slug}:${i}`;
      const audio = done(`tts ${slug} ${i + 1}`, await voice.tts.synthesize({ text, language: v.language, emotion: s.emotion, idempotencyKey: key }));
      const asr = done(`align ${slug} ${i + 1}`, await voice.aligner.align({ audio, text, language: v.language, idempotencyKey: `${key}:align` }));
      beats.push({ plate: plates[n]![i]!.id, cutout: cutout.id, voice: { key: audio.id, durationSec: audio.durationSec! }, words: alignCaptions(s, v.language, asr.words, audio.durationSec!) });
      console.log(`  ${slug} beat ${i + 1}: ${audio.durationSec!.toFixed(2)}s voice, ${asr.words.length} asr words, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    }
    assets.push(beats);
  }
  // Batch 3 — render.
  for (const [n, { slug, variant: v }] of items.entries()) {
    const spec = buildSpec({ id: `p6-${slug}`, variant: v, beats: assets[n]! });
    const out = done(`render ${slug}`, await renderer.render({ spec, idempotencyKey: `p6:${slug}` }));
    console.log(`RENDER ${slug} (${v.language}): ${storage.pathFor(out.id)} (${spec.durationInFrames} frames)`);
  }
  console.log('VOICE E2E OK — now listen to the files.');
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  // Best-effort even on failure, so neither service keeps the GPU.
  await comfy.free().catch(() => {});
  console.log('voice unload:', await voice.unload().catch((e: unknown) => `failed: ${String(e)}`));
}
