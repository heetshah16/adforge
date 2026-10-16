import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { VideoSpec } from '@adforge/core/spec/video-spec';
import { HyperframesRenderer } from '../src/render';
import { silentWav, solidPng, tmpStorage } from './helpers';

const cleanup: string[] = [];
afterEach(() => {
  for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function tiny() {
  const { root, storage } = tmpStorage();
  cleanup.push(root);
  const plate = await storage.put(solidPng(24, 42, [30, 90, 200]), { mime: 'image/png' });
  const voice = await storage.put(silentWav(0.2), { mime: 'audio/wav' });
  const spec: VideoSpec = {
    id: 'tiny',
    width: 240,
    height: 426,
    fps: 30,
    durationInFrames: 5,
    theme: { primary: '#000000', accent: '#ffffff' },
    scenes: [
      {
        startFrame: 0,
        durationInFrames: 5,
        motion: 'slow_zoom_in',
        layers: [
          { type: 'plate', key: plate.id },
          { type: 'text', content: 'हिंदी ok', position: 'top_third', weight: 'bold', scrim: true },
        ],
      },
    ],
    audio: { voice: [{ key: voice.id, startFrame: 0, durationInFrames: 5 }] },
    captions: { position: 'bottom_center', words: [{ text: 'असली', startFrame: 0, endFrame: 5 }] },
  };
  return { storage, spec, workDir: join(root, 'work') };
}

const frames = (file: string) =>
  Number(
    execFileSync(process.env.HYPERFRAMES_FFMPEG_PATH ? join(process.env.HYPERFRAMES_FFMPEG_PATH, '..', 'ffprobe') : 'ffprobe', [
      '-v', 'error', '-count_frames', '-select_streams', 'v:0',
      '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', file,
    ]).toString().trim(),
  );

describe('HyperframesRenderer (real Chrome + FFmpeg, no GPU)', () => {
  it('renders a 240x426, 5-frame spec into storage and cleans up', async () => {
    const { storage, spec, workDir } = await tiny();
    const r = await new HyperframesRenderer({ storage, workDir, quality: 'draft' }).render({ spec, idempotencyKey: 'tiny' });
    expect(r.status).toBe('done');
    if (r.status !== 'done') return;
    expect(r.value).toMatchObject({ mime: 'video/mp4', width: 240, height: 426 });
    expect(r.value.durationSec).toBeCloseTo(5 / 30, 6);
    expect(frames(storage.pathFor(r.value.id))).toBe(5);
    expect(existsSync(workDir) ? readdirSync(workDir) : []).toEqual([]); // project dir removed
  }, 180_000);

  it('rejects an invalid spec as INVALID_INPUT before launching Chrome', async () => {
    const { storage, spec, workDir } = await tiny();
    const bad = { ...spec, durationInFrames: 6 }; // scenes sum to 5
    const r = await new HyperframesRenderer({ storage, workDir }).render({ spec: bad, idempotencyKey: 'bad' });
    expect(r.status === 'failed' && r.error.code).toBe('INVALID_INPUT');
    expect(r.status === 'failed' && r.retryable).toBe(false);
  });

  it('turns a render that overruns its deadline into a retryable TIMEOUT and cleans up', async () => {
    const { storage, spec, workDir } = await tiny();
    const r = await new HyperframesRenderer({ storage, workDir, renderTimeoutMs: 1 }).render({ spec, idempotencyKey: 'slow' });
    expect(r.status === 'failed' && r.error.code).toBe('TIMEOUT');
    expect(r.status === 'failed' && r.retryable).toBe(true);
    expect(existsSync(workDir) ? readdirSync(workDir) : []).toEqual([]);
  }, 60_000);
});
