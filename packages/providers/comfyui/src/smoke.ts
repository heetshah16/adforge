import { join } from 'node:path';
import { REPO_ROOT, parseEnv } from '@adforge/core/config/env';
import type { MediaRef, ProviderResult } from '@adforge/core/providers/types';
import { LocalDiskStorage } from '@adforge/provider-local-storage';
import { createComfyProviders } from './providers';

/**
 * Live end-to-end check against a running ComfyUI (scripts/comfyui.ps1). Not part of `pnpm test`.
 * Same runId → same idempotency keys → ComfyUI returns cached results. Pass a new runId to render fresh.
 */
try {
  process.loadEnvFile(join(REPO_ROOT, '.env'));
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
}
const env = parseEnv(process.env);
const runId = process.argv[2] ?? 'v1';
const storage = new LocalDiskStorage(join(env.ADFORGE_DATA_DIR, 'media'), env.ADFORGE_PUBLIC_URL);
const comfy = createComfyProviders({
  baseUrl: env.COMFYUI_URL,
  storage,
  plateWorkflow: env.ADFORGE_COMFY_WORKFLOW_PLATE,
  cutoutWorkflow: env.ADFORGE_COMFY_WORKFLOW_CUTOUT,
  brollWorkflow: env.ADFORGE_COMFY_WORKFLOW_BROLL,
});

function expectDone(step: string, r: ProviderResult<MediaRef>): MediaRef {
  if (r.status !== 'done') {
    console.error(`FAIL ${step}:`, r.status === 'failed' ? `${r.error.code} ${r.error.message}` : 'still pending');
    process.exit(1);
  }
  console.log(`ok   ${step.padEnd(8)} ${(r.latencyMs / 1000).toFixed(1)}s  ${r.value.mime} ${r.value.width}x${r.value.height}  ${r.value.url}`);
  return r.value;
}

await comfy.preflight();
console.log(`ComfyUI up at ${env.COMFYUI_URL}; storage ${join(env.ADFORGE_DATA_DIR, 'media')}; run ${runId}`);

const plate = expectDone(
  'plate',
  await comfy.image.generate({
    prompt: 'warm natural daylight, real lived-in kitchen interior, wooden countertop, empty surface in the foreground',
    width: 768,
    height: 1344,
    idempotencyKey: `smoke:${runId}:plate`,
  }),
);
const product = expectDone(
  'product',
  await comfy.image.generate({
    prompt: 'studio product photo of a single amber glass bottle with a plain paper label, isolated on a pure white background',
    width: 768,
    height: 1344,
    idempotencyKey: `smoke:${runId}:product`,
  }),
);
expectDone('cutout', await comfy.cutout.cutout({ image: product, idempotencyKey: `smoke:${runId}:cutout` }));

const handle = await comfy.video.submit({
  mode: 'image_to_video',
  prompt: 'slow drifting warm sunlight, soft dust particles in the air, subtle ambient motion, static camera',
  firstFrame: plate,
  durationSec: 5,
  aspectRatio: '9:16',
  resolution: '720p',
  idempotencyKey: `smoke:${runId}:broll`,
});
console.log(`...  broll    submitted ${handle.externalId}, polling every ${handle.pollAfterMs / 1000}s`);
const deadline = Date.now() + 15 * 60_000;
let r = await comfy.video.poll(handle);
while (r.status === 'pending' && Date.now() < deadline) {
  await new Promise((res) => setTimeout(res, handle.pollAfterMs));
  r = await comfy.video.poll(handle);
}
const clip = expectDone('broll', r);
if (clip.durationSec === undefined) {
  console.error('FAIL broll: missing durationSec');
  process.exit(1);
}
console.log(`     broll duration ${clip.durationSec.toFixed(2)}s`);
console.log('SMOKE OK');
