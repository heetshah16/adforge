import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { upgradeSpec } from '@adforge/core/spec/upgrade-spec';
import type { VideoSpecV1 } from '@adforge/core/spec/video-spec';
import { HyperframesRenderer } from '../src/render';
import { silentWav, solidPng, tmpStorage } from './helpers';

/**
 * Pixel identity: the per-frame sha256 of two small renders, pinned in a golden.
 * Recorded from the v1 compositor before C2 touched compose.ts; v2 must reproduce it exactly.
 */
const ffmpeg = process.env.HYPERFRAMES_FFMPEG_PATH ?? 'ffmpeg';
const N = 5;

const { root, storage } = tmpStorage();
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A real 1 s H.264 clip, single-threaded so its bytes are reproducible. */
function brollMp4(): Uint8Array {
  const out = join(root, 'broll.mp4');
  execFileSync(ffmpeg, [
    '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=240x426:rate=30:duration=1',
    '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-threads', '1', '-fflags', '+bitexact', '-flags:v', '+bitexact', out,
  ]);
  return readFileSync(out);
}

async function v1Specs(): Promise<Record<string, VideoSpecV1>> {
  const plate = await storage.put(solidPng(24, 42, [30, 90, 200]), { mime: 'image/png' });
  const cutout = await storage.put(solidPng(12, 30, [220, 40, 40]), { mime: 'image/png' });
  const broll = await storage.put(brollMp4(), { mime: 'video/mp4' });
  const voice = await storage.put(silentWav(N / 30), { mime: 'audio/wav' });
  const base = { width: 240, height: 426, fps: 30 as const, durationInFrames: N, theme: { primary: '#141414', accent: '#f5b301' } };
  const audio = { voice: [{ key: voice.id, startFrame: 0, durationInFrames: N }] };
  return {
    'plate-cutout-text': {
      ...base,
      id: 'plate-cutout-text',
      scenes: [{
        startFrame: 0, durationInFrames: N, motion: 'slow_zoom_in',
        layers: [
          { type: 'plate', key: plate.id },
          // anchorX < 0.5 so the upgraded product box has x < 0 (the product-only exemption).
          { type: 'cutout', key: cutout.id, anchorX: 0.4, anchorY: 0.86, heightFrac: 0.42, shadow: true },
          { type: 'text', content: 'हिंदी ok', position: 'top_third', weight: 'bold', scrim: true },
        ],
      }],
      audio,
      captions: { position: 'bottom_center', words: [{ text: 'असली', startFrame: 1, endFrame: 4 }] },
    },
    broll: {
      ...base,
      id: 'broll',
      scenes: [{
        startFrame: 0, durationInFrames: N, motion: 'static',
        layers: [
          { type: 'video', key: broll.id, trimStartFrame: 3 },
          { type: 'text', content: 'Cold pressed', position: 'mid_lower', weight: 'chunky', scrim: false },
        ],
      }],
      audio,
      captions: { position: 'top_third', words: [{ text: 'Stop', startFrame: 0, endFrame: 2 }, { text: 'now', startFrame: 2, endFrame: 5 }] },
    },
  };
}

/** sha256 of each decoded video frame. */
const frameHashes = (file: string): string[] =>
  execFileSync(ffmpeg, ['-v', 'error', '-i', file, '-map', '0:v', '-f', 'framehash', '-hash', 'sha256', '-'])
    .toString()
    .split('\n')
    .filter((l) => l.trim() && !l.startsWith('#'))
    .map((l) => l.split(',').at(-1)!.trim());

describe('v2 identity (real Chrome + FFmpeg, 240x426, 5 frames)', () => {
  it('renders upgradeSpec(v1) frame-hash-identical to the v1 baseline', async () => {
    const renderer = new HyperframesRenderer({ storage, workDir: join(root, 'work'), quality: 'draft' });
    const hashes: Record<string, string[]> = {};
    for (const [name, spec] of Object.entries(await v1Specs())) {
      const r = await renderer.render({ spec: upgradeSpec(spec), idempotencyKey: name });
      if (r.status !== 'done') throw new Error(`${name}: ${r.status === 'failed' ? r.error.message : 'pending'}`);
      hashes[name] = frameHashes(storage.pathFor(r.value.id));
      expect(hashes[name]).toHaveLength(N);
    }
    // Read, not toMatchFileSnapshot: `vitest -u` must never be able to rewrite the baseline.
    expect(hashes).toEqual(JSON.parse(readFileSync(new URL('./golden/v1-frame-hashes.json', import.meta.url), 'utf8')));
  }, 240_000);
});
