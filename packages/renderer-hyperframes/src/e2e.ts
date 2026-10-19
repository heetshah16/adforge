import { join } from 'node:path';
import { REPO_ROOT, parseEnv } from '@adforge/core/config/env';
import type { MediaRef, ProviderResult } from '@adforge/core/providers/types';
import { upgradeSpec } from '@adforge/core/spec/upgrade-spec';
import { createComfyProviders } from '@adforge/provider-comfyui';
import { LocalDiskStorage } from '@adforge/provider-local-storage';
import { HyperframesRenderer } from './render';

/**
 * P3 end-to-end: real plate + real cutout + real b-roll (re-fetched from the P2 smoke run's
 * idempotency keys, so ComfyUI returns cached results instantly) → 20 s, 1080×1920 MP4.
 * Needs ComfyUI running (scripts/comfyui.ps1). Voice is a placeholder tone until P6.
 */
try {
  process.loadEnvFile(join(REPO_ROOT, '.env'));
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
}
const env = parseEnv(process.env);
const storage = new LocalDiskStorage(join(env.ADFORGE_DATA_DIR, 'media'), env.ADFORGE_PUBLIC_URL);
const comfy = createComfyProviders({
  baseUrl: env.COMFYUI_URL,
  storage,
  plateWorkflow: env.ADFORGE_COMFY_WORKFLOW_PLATE,
  cutoutWorkflow: env.ADFORGE_COMFY_WORKFLOW_CUTOUT,
  brollWorkflow: env.ADFORGE_COMFY_WORKFLOW_BROLL,
});

const done = (step: string, r: ProviderResult<MediaRef>): MediaRef => {
  if (r.status !== 'done') {
    console.error(`FAIL ${step}:`, r.status === 'failed' ? `${r.error.code} ${r.error.message}` : 'pending');
    process.exit(1);
  }
  return r.value;
};

/** A quiet 220 Hz tone so the audio track is audibly present (placeholder until P6 voice). */
function toneWav(seconds: number): Uint8Array {
  const rate = 24000;
  const n = Math.round(seconds * rate);
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * i) / rate) * 1500), 44 + i * 2);
  return b;
}

await comfy.preflight();
const run = 'p2-check';
const plate = done('plate', await comfy.image.generate({
  prompt: 'warm natural daylight, real lived-in kitchen interior, wooden countertop, empty surface in the foreground',
  width: 768, height: 1344, idempotencyKey: `smoke:${run}:plate`,
}));
const product = done('product', await comfy.image.generate({
  prompt: 'studio product photo of a single amber glass bottle with a plain paper label, isolated on a pure white background',
  width: 768, height: 1344, idempotencyKey: `smoke:${run}:product`,
}));
const cutout = done('cutout', await comfy.cutout.cutout({ image: product, idempotencyKey: `smoke:${run}:cutout` }));
const handle = await comfy.video.submit({
  mode: 'image_to_video',
  prompt: 'slow drifting warm sunlight, soft dust particles in the air, subtle ambient motion, static camera',
  firstFrame: plate, durationSec: 5, aspectRatio: '9:16', resolution: '720p', idempotencyKey: `smoke:${run}:broll`,
});
let br = await comfy.video.poll(handle);
const deadline = Date.now() + 15 * 60_000;
while (br.status === 'pending' && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, handle.pollAfterMs));
  br = await comfy.video.poll(handle);
}
const broll = done('broll', br);
const voice = await storage.put(toneWav(19), { mime: 'audio/wav', durationSec: 19 });

const words = 'Stop buying oil that was bleached twice . Cold pressed . Nothing added . Taste the difference'.split(' ');
const spec = upgradeSpec({
  id: 'p3-e2e',
  width: 1080,
  height: 1920,
  fps: 30,
  durationInFrames: 600,
  theme: { primary: '#141414', accent: '#f5b301' },
  scenes: [
    { startFrame: 0, durationInFrames: 105, motion: 'slow_zoom_in', layers: [
      { type: 'plate', key: plate.id },
      { type: 'cutout', key: cutout.id, anchorX: 0.5, anchorY: 0.84, heightFrac: 0.46, shadow: true },
      { type: 'text', content: 'Bleached twice?', position: 'top_third', weight: 'chunky', scrim: true },
    ] },
    { startFrame: 105, durationInFrames: 150, motion: 'static', layers: [{ type: 'video', key: broll.id, trimStartFrame: 0 }] },
    { startFrame: 255, durationInFrames: 165, motion: 'slow_pan', layers: [
      { type: 'plate', key: plate.id },
      { type: 'cutout', key: cutout.id, anchorX: 0.5, anchorY: 0.84, heightFrac: 0.46, shadow: true },
      { type: 'text', content: 'Cold pressed. Nothing added.', position: 'top_third', weight: 'bold', scrim: true },
    ] },
    { startFrame: 420, durationInFrames: 180, motion: 'slow_zoom_out', layers: [
      { type: 'plate', key: plate.id },
      { type: 'cutout', key: cutout.id, anchorX: 0.5, anchorY: 0.84, heightFrac: 0.5, shadow: true },
      { type: 'text', content: 'असली स्वाद', position: 'top_third', weight: 'bold', scrim: true },
    ] },
  ],
  audio: { voice: [{ key: voice.id, startFrame: 0, durationInFrames: 570 }] },
  captions: {
    position: 'bottom_center',
    words: words.filter((w) => w !== '.').map((text, i) => ({ text, startFrame: i * 36, endFrame: i * 36 + 30 })),
  },
});

const renderer = new HyperframesRenderer({ storage, workDir: join(env.ADFORGE_DATA_DIR, 'render-work') });
const t0 = Date.now();
const out = done('render', await renderer.render({ spec, idempotencyKey: 'p3-e2e' }));
console.log(`RENDER OK in ${((Date.now() - t0) / 1000).toFixed(1)}s → ${storage.pathFor(out.id)}`);
console.log(`  ${out.width}x${out.height}, ${out.durationSec}s, ${out.bytes} bytes`);
