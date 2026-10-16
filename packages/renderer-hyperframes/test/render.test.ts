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

async function tiny(n = 5) {
  const { root, storage } = tmpStorage();
  cleanup.push(root);
  const plate = await storage.put(solidPng(24, 42, [30, 90, 200]), { mime: 'image/png' });
  const voice = await storage.put(silentWav(n / 30), { mime: 'audio/wav' });
  const spec: VideoSpec = {
    id: 'tiny',
    width: 240,
    height: 426,
    fps: 30,
    durationInFrames: n,
    theme: { primary: '#000000', accent: '#ffffff' },
    scenes: [
      {
        startFrame: 0,
        durationInFrames: n,
        motion: 'slow_zoom_in',
        layers: [
          { type: 'plate', key: plate.id },
          { type: 'text', content: 'हिंदी ok', position: 'top_third', weight: 'bold', scrim: true },
        ],
      },
    ],
    audio: { voice: [{ key: voice.id, startFrame: 0, durationInFrames: n }] },
    captions: { position: 'bottom_center', words: [{ text: 'असली', startFrame: 0, endFrame: n }] },
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

const chromeCount = () =>
  execFileSync('tasklist', ['/FI', 'IMAGENAME eq chrome-headless-shell.exe', '/NH']).toString().split(String.fromCharCode(10)).filter((l) => l.includes('chrome-headless-shell')).length;

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

  it('reports a missing asset key as a non-retryable INVALID_INPUT, never TIMEOUT, and leaves nothing behind', async () => {
    const { storage, spec, workDir } = await tiny();
    const missing = `99/${'9'.repeat(64)}.png`;
    spec.scenes[0]!.layers[0] = { type: 'plate', key: missing };
    const before = chromeCount();
    const r = await new HyperframesRenderer({ storage, workDir, renderTimeoutMs: 60_000 }).render({ spec, idempotencyKey: 'missing' });
    expect(r.status === 'failed' && r.error.code).toBe('INVALID_INPUT');
    expect(r.status === 'failed' && r.retryable).toBe(false);
    expect(r.status === 'failed' && r.error.message).toContain(missing);
    expect(existsSync(workDir) ? readdirSync(workDir) : []).toEqual([]);
    expect(chromeCount()).toBe(before);
  }, 60_000);

  it('turns a pre-aborted deadline (Chrome never launches) into a retryable TIMEOUT and cleans up', async () => {
    const { storage, spec, workDir } = await tiny();
    const r = await new HyperframesRenderer({ storage, workDir, renderTimeoutMs: 1 }).render({ spec, idempotencyKey: 'slow' });
    expect(r.status === 'failed' && r.error.code).toBe('TIMEOUT');
    expect(r.status === 'failed' && r.retryable).toBe(true);
    expect(existsSync(workDir) ? readdirSync(workDir) : []).toEqual([]);
  }, 60_000);

  it('kills a hung mid-render at the deadline: TIMEOUT, empty workDir, no Chrome left', async () => {
    const { storage, spec, workDir } = await tiny(600);
    const before = chromeCount();
    const t0 = Date.now();
    const r = await new HyperframesRenderer({ storage, workDir, renderTimeoutMs: 3000 }).render({ spec, idempotencyKey: 'hung' });
    const took = Date.now() - t0;
    expect(r.status === 'failed' && r.error.code).toBe('TIMEOUT');
    expect(r.status === 'failed' && r.retryable).toBe(true);
    expect(took).toBeLessThan(20_000);
    expect(existsSync(workDir) ? readdirSync(workDir) : []).toEqual([]);
    for (let i = 0; i < 25 && chromeCount() > before; i++) await new Promise((res) => setTimeout(res, 200));
    expect(chromeCount()).toBe(before);
  }, 60_000);
});
