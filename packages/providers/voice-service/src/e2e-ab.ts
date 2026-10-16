import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, parseEnv } from '@adforge/core/config/env';
import { PIPELINE } from '@adforge/core/config/pipeline';
import { TREATMENTS } from '@adforge/core/config/treatments';
import type { DirectorVariant } from '@adforge/core/llm/schemas';
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
 * P6c A/B: the SAME saved Director English variant voiced by Chatterbox (A) then Qwen (B), rendered to two MP4s for the listening check.
 * Needs ComfyUI, voice (8190) and voice-qwen (8191) running. Alignment is Whisper on the voice service for both engines.
 */
try {
  process.loadEnvFile(join(REPO_ROOT, '.env'));
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
}
const env = parseEnv(process.env);
const qwenBaseUrl = process.env.ADFORGE_VOICE_QWEN_URL ?? 'http://127.0.0.1:8191';
const storage = new LocalDiskStorage(join(env.ADFORGE_DATA_DIR, 'media'), env.ADFORGE_PUBLIC_URL);
const comfy = createComfyProviders({
  baseUrl: env.COMFYUI_URL, storage,
  plateWorkflow: env.ADFORGE_COMFY_WORKFLOW_PLATE, cutoutWorkflow: env.ADFORGE_COMFY_WORKFLOW_CUTOUT, brollWorkflow: env.ADFORGE_COMFY_WORKFLOW_BROLL,
});
const cfgQwen = { ...PIPELINE, voice: { ...PIPELINE.voice, engineByLanguage: { ...PIPELINE.voice.engineByLanguage, en: 'qwen' as const } } };
const engines = [
  { label: 'chatterbox', voice: createVoiceProviders({ baseUrl: env.ADFORGE_VOICE_URL, qwenBaseUrl, storage }) },
  { label: 'qwen', voice: createVoiceProviders({ baseUrl: env.ADFORGE_VOICE_URL, qwenBaseUrl, storage, cfg: cfgQwen }) },
];
const renderer = new HyperframesRenderer({ storage, workDir: join(env.ADFORGE_DATA_DIR, 'render-work') });
const done = <T>(step: string, r: ProviderResult<T>): T => {
  if (r.status !== 'done') { throw new Error(`FAIL ${step}: ${r.status === 'failed' ? `${r.error.code} ${r.error.message}` : 'pending'}`); }
  return r.value;
};

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
const saved = SavedDirection.parse(JSON.parse(readFileSync(join(env.ADFORGE_DATA_DIR, 'e2e', 'directions', 'krishna-special-hing.json'), 'utf8')));
if (saved.language !== 'en') throw new Error(`expected an en direction, got ${saved.language}`);
const { slug } = saved;
const v: DirectorVariant = { ...(saved.output.variants[0] as unknown as DirectorVariant), language: 'en' };
console.log(`A/B: ${slug} (${v.language}), ${v.scenes.length} beats`);

try {
  await comfy.preflight();
  console.log('voice health:', await engines[0]!.voice.health());

  const plates: MediaRef[] = [];
  const suffix = TREATMENTS[v.visual_treatment].platePromptSuffix;
  for (const [i, s] of v.scenes.entries()) {
    plates.push(done(`plate ${i + 1}`, await comfy.image.generate({ prompt: `${s.scene}, ${suffix}`, width: 768, height: 1344, idempotencyKey: `p6:${slug}:plate:${i}` })));
  }
  const product = done('product', await comfy.image.generate({
    prompt: 'studio product photo of a single amber glass bottle with a plain paper label, isolated on a pure white background',
    width: 768, height: 1344, idempotencyKey: 'smoke:p2-check:product',
  }));
  const cutout = done('cutout', await comfy.cutout.cutout({ image: product, idempotencyKey: 'smoke:p2-check:cutout' }));

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

  for (const { label, voice } of engines) {
    const g0 = Date.now();
    const beats: BeatAssets[] = [];
    for (const [i, s] of v.scenes.entries()) {
      const t0 = Date.now();
      const text = ttsText(s, 'en');
      const key = `p6c-ab:${label}:${slug}:${i}`;
      const audio = done(`tts ${label} ${i + 1}`, await voice.tts.synthesize({ text, language: 'en', emotion: s.emotion, idempotencyKey: key }));
      const asr = done(`align ${label} ${i + 1}`, await voice.aligner.align({ audio, text, language: 'en', idempotencyKey: `${key}:align` }));
      beats.push({ plate: plates[i]!.id, cutout: cutout.id, voice: { key: audio.id, durationSec: audio.durationSec! }, words: alignCaptions(s, 'en', asr.words, audio.durationSec!) });
      console.log(`  [${label}] (served by ${voice.tts.idFor('en')}) beat ${i + 1}: ${audio.durationSec!.toFixed(2)}s voice, ${asr.words.length} asr words, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    }
    console.log(`  [${label}] generation total: ${((Date.now() - g0) / 1000).toFixed(1)}s`);
    const spec = buildSpec({ id: `p6c-ab-${label}-${slug}`, variant: v, beats });
    const out = done(`render ${label}`, await renderer.render({ spec, idempotencyKey: `p6c-ab:${label}:${slug}` }));
    console.log(`RENDER ${label}: ${storage.pathFor(out.id)} (${spec.durationInFrames} frames)`);
    console.log(`voice unload after ${label}:`, await voice.unload().catch((e: unknown) => `failed: ${String(e)}`));
  }
  console.log('VOICE A/B OK — now listen to both files.');
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await comfy.free().catch(() => {});
  console.log('final unload:', await engines[0]!.voice.unload().catch((e: unknown) => `failed: ${String(e)}`));
}
