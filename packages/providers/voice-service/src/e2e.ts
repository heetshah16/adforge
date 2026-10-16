import { join } from 'node:path';
import { REPO_ROOT, parseEnv } from '@adforge/core/config/env';
import { TREATMENTS } from '@adforge/core/config/treatments';
import { loadPrompt } from '@adforge/core/llm/prompts';
import type { DirectorOutput, DirectorVariant } from '@adforge/core/llm/schemas';
import type { MediaRef, ProviderResult } from '@adforge/core/providers/types';
import { alignScript } from '@adforge/core/spec/align-script';
import { buildSpec, type BeatAssets } from '@adforge/core/spec/build-spec';
import { createComfyProviders } from '@adforge/provider-comfyui';
import { LocalDiskStorage } from '@adforge/provider-local-storage';
import { HyperframesRenderer } from '@adforge/renderer-hyperframes';
import { createVoiceProviders } from './providers';

/** P6 end-to-end: anchor variant 1 voiced in en / hi / hinglish → three rendered MP4s for the listening check. */
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
  if (r.status !== 'done') { console.error(`FAIL ${step}:`, r.status === 'failed' ? `${r.error.code} ${r.error.message}` : 'pending'); process.exit(1); }
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
const variants: DirectorVariant[] = [
  base,
  { ...base, language: 'hi', scenes: base.scenes.map((s, i) => ({ ...s, vo: VO.hi[i]! })) },
  { ...base, language: 'hinglish', scenes: base.scenes.map((s, i) => ({ ...s, vo: VO.hinglish[i]! })) },
];

await comfy.preflight();
console.log('voice health:', await voice.health());

// Batch 1 — ComfyUI: plates for each beat (shared across languages) + the product cutout.
const suffix = TREATMENTS[base.visual_treatment].platePromptSuffix;
const plates: MediaRef[] = [];
for (const [i, s] of base.scenes.entries()) {
  plates.push(done(`plate ${i + 1}`, await comfy.image.generate({ prompt: `${s.scene}, ${suffix}`, width: 768, height: 1344, idempotencyKey: `p6:plate:${i}` })));
}
const product = done('product', await comfy.image.generate({
  prompt: 'studio product photo of a single amber glass bottle with a plain paper label, isolated on a pure white background',
  width: 768, height: 1344, idempotencyKey: 'smoke:p2-check:product',
}));
const cutout = done('cutout', await comfy.cutout.cutout({ image: product, idempotencyKey: 'smoke:p2-check:cutout' }));
await comfy.free(); // hand the GPU to the voice service

// Batch 2 — voice + alignment for every language.
const assets: BeatAssets[][] = [];
for (const v of variants) {
  const beats: BeatAssets[] = [];
  for (const [i, s] of v.scenes.entries()) {
    const t0 = Date.now();
    const audio = done(`tts ${v.language} ${i + 1}`, await voice.tts.synthesize({ text: s.vo, language: v.language, emotion: s.emotion, idempotencyKey: `p6:${v.language}:${i}` }));
    const asr = done(`align ${v.language} ${i + 1}`, await voice.aligner.align({ audio, text: s.vo, language: v.language, idempotencyKey: `p6:${v.language}:${i}:align` }));
    beats.push({ plate: plates[i]!.id, cutout: cutout.id, voice: { key: audio.id, durationSec: audio.durationSec! }, words: alignScript(s.vo, asr.words, audio.durationSec!) });
    console.log(`  ${v.language} beat ${i + 1}: ${audio.durationSec!.toFixed(2)}s voice, ${asr.words.length} asr words, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }
  assets.push(beats);
}
console.log('voice unload:', await voice.unload());

// Batch 3 — render.
for (const [n, v] of variants.entries()) {
  const spec = buildSpec({ id: `p6-${v.language}`, variant: v, beats: assets[n]! });
  const out = done(`render ${v.language}`, await renderer.render({ spec, idempotencyKey: `p6:${v.language}` }));
  console.log(`RENDER ${v.language}: ${storage.pathFor(out.id)} (${spec.durationInFrames} frames)`);
}
console.log('VOICE E2E OK — now listen to all three files.');
