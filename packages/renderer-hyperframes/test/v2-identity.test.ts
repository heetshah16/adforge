import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { upgradeSpec } from '@adforge/core/spec/upgrade-spec';
import type { VideoSpec } from '@adforge/core/spec/video-spec';
import { assetPath } from '../src/compose';
import { HyperframesRenderer } from '../src/render';
import { silentWav, solidPng, tmpStorage } from './helpers';
import { N, identitySpecs, type IdentityKeys } from './identity-specs';

/**
 * Pixel identity, compared within one run on one machine (hashes differ across OS, Chrome and x264).
 * The v1 side is golden/v1-<name>.html.tmpl: the pre-C2 compositor's HTML for these specs
 * (generated once from 3398f78's compose.ts), with {{role}} placeholders for content-addressed srcs.
 */
const ffmpeg = process.env.HYPERFRAMES_FFMPEG_PATH ?? 'ffmpeg';

const { root, storage } = tmpStorage();
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A real 1 s H.264 clip. */
function brollMp4(): Uint8Array {
  const out = join(root, 'broll.mp4');
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=240x426:rate=30:duration=1', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', out]);
  return readFileSync(out);
}

async function keys(): Promise<IdentityKeys> {
  return {
    plate: (await storage.put(solidPng(24, 42, [30, 90, 200]), { mime: 'image/png' })).id,
    cutout: (await storage.put(solidPng(12, 30, [220, 40, 40]), { mime: 'image/png' })).id,
    broll: (await storage.put(brollMp4(), { mime: 'video/mp4' })).id,
    voice: (await storage.put(silentWav(N / 30), { mime: 'audio/wav' })).id,
  };
}

/** sha256 of each decoded video frame. */
const frameHashes = (file: string): string[] =>
  execFileSync(ffmpeg, ['-v', 'error', '-i', file, '-map', '0:v', '-f', 'framehash', '-hash', 'sha256', '-'])
    .toString()
    .split('\n')
    .filter((l) => l.trim() && !l.startsWith('#'))
    .map((l) => l.split(',').at(-1)!.trim());

/** Each decoded frame as 8-bit gray pixels. */
const grayFrames = (file: string, size: number): Uint8Array[] => {
  const raw = execFileSync(ffmpeg, ['-v', 'error', '-i', file, '-map', '0:v', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 64 << 20 });
  return Array.from({ length: raw.length / size }, (_, i) => raw.subarray(i * size, (i + 1) * size));
};

let lastRender = '';
async function render(spec: VideoSpec, id: string, compose?: (spec: VideoSpec) => string): Promise<string[]> {
  const renderer = new HyperframesRenderer({ storage, workDir: join(root, 'work'), quality: 'draft', ...(compose ? { compose } : {}) });
  const r = await renderer.render({ spec, idempotencyKey: id });
  if (r.status !== 'done') throw new Error(`${id}: ${r.status === 'failed' ? r.error.message : 'pending'}`);
  lastRender = storage.pathFor(r.value.id);
  const h = frameHashes(lastRender);
  expect(h).toHaveLength(N);
  return h;
}

describe('v2 identity (real Chrome + FFmpeg, 240x426, 5 frames)', () => {
  it('upgradeSpec(v1) through the v2 compositor renders frame-identical to the v1 compositor\'s HTML', async () => {
    const k = await keys();
    for (const [name, v1] of Object.entries(identitySpecs(k))) {
      let html = readFileSync(new URL(`./golden/v1-${name}.html.tmpl`, import.meta.url), 'utf8');
      for (const [role, key] of Object.entries(k)) html = html.replaceAll(`{{${role}}}`, assetPath(key));
      expect(html).not.toContain('{{');
      const spec = upgradeSpec(v1);
      const v1Frames = await render(spec, `${name}:v1`, () => html);
      const v2Frames = await render(spec, `${name}:v2`);
      expect(new Set(v1Frames).size, `${name}: frames should not all be identical`).toBeGreaterThan(1);
      expect(v2Frames, name).toEqual(v1Frames);
    }
  }, 240_000);

  it('an element shows from its own revealFrame: a headline revealed at scene start + 2', async () => {
    const plate = (await storage.put(solidPng(24, 42, [30, 90, 200]), { mime: 'image/png' })).id;
    const voice = (await storage.put(silentWav(N / 30), { mime: 'audio/wav' })).id;
    const spec = upgradeSpec({
      id: 'reveal', width: 240, height: 426, fps: 30, durationInFrames: N, theme: { primary: '#141414', accent: '#f5b301' },
      scenes: [{ startFrame: 0, durationInFrames: N, motion: 'static', layers: [
        { type: 'plate', key: plate },
        { type: 'text', content: 'Later', position: 'top_third', weight: 'chunky', scrim: true },
      ] }],
      audio: { voice: [{ key: voice, startFrame: 0, durationInFrames: N }] },
      captions: { position: 'bottom_center', words: [] },
    });
    spec.scenes[0]!.layers[1]!.revealFrame = 2;
    const h = await render(spec, 'reveal');
    for (const f of [h[2], h[3], h[4]]) expect([h[0], h[1]]).not.toContain(f);
    // Hashes alone are weak here: x264 refines a static picture frame to frame, so they differ even with
    // the headline at frame 0 (checked). So also measure the pixels: mean |Δ| from frame 0, in 0–255 gray.
    const g = grayFrames(lastRender, 240 * 426);
    const delta = g.map((f) => f.reduce((sum, v, i) => sum + Math.abs(v - g[0]![i]!), 0) / f.length);
    expect(delta[1]).toBeLessThan(1); // nothing new before the reveal
    for (const d of delta.slice(2)) expect(d).toBeGreaterThan(5); // the headline is up from frame 2
  }, 120_000);
});
