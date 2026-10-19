import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { upgradeSpec } from '@adforge/core/spec/upgrade-spec';
import { FONT_FILES } from '../src/compose';
import { specKeys, stageProject } from '../src/stage';
import { silentWav, solidPng, tmpStorage } from './helpers';

const cleanup: string[] = [];
afterEach(() => {
  for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function fixture() {
  const { root, storage } = tmpStorage();
  cleanup.push(root);
  const plate = await storage.put(solidPng(24, 42, [200, 120, 40]), { mime: 'image/png' });
  const voice = await storage.put(silentWav(0.2), { mime: 'audio/wav' });
  const spec = upgradeSpec({
    id: 't',
    width: 240,
    height: 426,
    fps: 30,
    durationInFrames: 5,
    theme: { primary: '#000000', accent: '#ffffff' },
    scenes: [{ startFrame: 0, durationInFrames: 5, motion: 'static', layers: [{ type: 'plate', key: plate.id }, { type: 'plate', key: plate.id }] }],
    audio: { voice: [{ key: voice.id, startFrame: 0, durationInFrames: 5 }] },
    captions: { position: 'bottom_center', words: [{ text: 'hi', startFrame: 0, endFrame: 5 }] },
  });
  const dir = mkdtempSync(join(tmpdir(), 'adforge-stage-'));
  cleanup.push(dir);
  return { storage, spec, dir, plate, voice };
}

describe('specKeys', () => {
  it('lists every referenced key once', async () => {
    const { spec, plate, voice } = await fixture();
    expect(specKeys(spec).sort()).toEqual([plate.id, voice.id].sort());
  });

  it('includes music and sfx tracks', async () => {
    const { spec, plate, voice } = await fixture();
    const music = `ab/${'a'.repeat(64)}.wav`;
    const sfx = `cd/${'c'.repeat(64)}.wav`;
    spec.audio.music.push({ key: music, startFrame: 0, durationInFrames: 5, gainDb: -12 });
    spec.audio.sfx.push({ key: sfx, startFrame: 1, durationInFrames: 2, gainDb: 0 });
    expect(specKeys(spec).sort()).toEqual([plate.id, voice.id, music, sfx].sort());
  });
});

describe('stageProject', () => {
  it('copies assets, gsap and every font file into the project', async () => {
    const { storage, spec, dir, plate, voice } = await fixture();
    await stageProject(spec, storage, dir);
    expect(existsSync(join(dir, 'assets', plate.id.slice(3)))).toBe(true);
    expect(existsSync(join(dir, 'assets', voice.id.slice(3)))).toBe(true);
    expect(existsSync(join(dir, 'assets', 'gsap.min.js'))).toBe(true);
    for (const f of FONT_FILES) expect(existsSync(join(dir, 'assets', 'fonts', f.file))).toBe(true);
  });

  it('fails before writing anything when a key is missing, naming it', async () => {
    const { storage, spec, dir } = await fixture();
    const missing = `99/${'9'.repeat(64)}.png`;
    (spec.scenes[0]!.layers[1] as { key: string }).key = missing;
    await expect(stageProject(spec, storage, dir)).rejects.toThrow(missing);
    expect(readdirSync(dir)).toEqual([]);
  });
});
