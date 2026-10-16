import { describe, expect, it } from 'vitest';
import { loadPrompt } from '../src/llm/prompts';
import type { DirectorOutput } from '../src/llm/schemas';
import { VideoSpec } from '../src/spec/video-spec';
import { buildSpec, type BeatAssets } from '../src/spec/build-spec';

const variant = () => {
  const t = loadPrompt('director').text;
  return (JSON.parse(t.slice(t.indexOf('```json') + 7, t.lastIndexOf('```'))) as DirectorOutput).variants[0]!; // problem_solution: absent, absent, hero, hero
};
const key = (c: string, ext = 'png') => `${c}${c}/${c.repeat(64)}.${ext}`;
const beat = (i: number, voiceSec: number, extra: Partial<BeatAssets> = {}): BeatAssets => ({
  plate: key(String(i)),
  cutout: key('c'),
  voice: { key: key(String(i), 'wav'), durationSec: voiceSec },
  words: [{ text: 'w1', startSec: 0.1, endSec: 0.5 }, { text: 'w2', startSec: 0.5, endSec: 1.0 }],
  ...extra,
});

describe('buildSpec', () => {
  it('produces a valid spec whose scene frames sum exactly', () => {
    const spec = buildSpec({ id: 'v1', variant: variant(), beats: [beat(1, 3), beat(2, 4), beat(3, 5), beat(4, 4)] });
    expect(spec.durationInFrames).toBe(spec.scenes.reduce((n, s) => n + s.durationInFrames, 0));
    expect(spec.scenes.map((s) => s.durationInFrames)).toEqual([120, 150, 180, 150]); // planned 4,5,6,5 s; VO fits
  });

  it('truncates a caption token over 40 chars instead of failing the spec', () => {
    const long = 'x'.repeat(60);
    const spec = buildSpec({ id: 'v1', variant: variant(), beats: [beat(1, 3, { words: [{ text: long, startSec: 0.1, endSec: 0.5 }] }), beat(2, 4), beat(3, 5), beat(4, 4)] });
    expect(spec.captions.words[0]!.text).toBe('x'.repeat(39) + '…');
  });

  it('stretches a beat to fit a long voice clip plus the tail', () => {
    const spec = buildSpec({ id: 'v1', variant: variant(), beats: [beat(1, 4.5), beat(2, 4), beat(3, 5), beat(4, 4)] });
    expect(spec.scenes[0]!.durationInFrames).toBe(135 + 6);
    expect(spec.audio.voice[1]!.startFrame).toBe(141);
  });

  it('puts the real cutout on hero beats only, never on absent beats', () => {
    const spec = buildSpec({ id: 'v1', variant: variant(), beats: [beat(1, 3), beat(2, 4), beat(3, 5), beat(4, 4)] });
    const hasCutout = spec.scenes.map((s) => s.layers.some((l) => l.type === 'cutout'));
    expect(hasCutout).toEqual([false, false, true, true]);
  });

  it('uses b-roll only on an absent beat it fully covers, else the plate', () => {
    const short = buildSpec({ id: 'v1', variant: variant(), beats: [beat(1, 3, { broll: { key: key('b', 'mp4'), durationSec: 3 } }), beat(2, 4), beat(3, 5), beat(4, 4)] });
    expect(short.scenes[0]!.layers[0]!.type).toBe('plate'); // 3s clip < 4s beat
    const long = buildSpec({ id: 'v1', variant: variant(), beats: [beat(1, 3, { broll: { key: key('b', 'mp4'), durationSec: 5.04 } }), beat(2, 4), beat(3, 5), beat(4, 4)] });
    expect(long.scenes[0]!.layers[0]).toMatchObject({ type: 'video', trimStartFrame: 0 });
  });

  it('never puts b-roll on a hero beat', () => {
    const spec = buildSpec({ id: 'v1', variant: variant(), beats: [beat(1, 3), beat(2, 4), beat(3, 5, { broll: { key: key('b', 'mp4'), durationSec: 8 } }), beat(4, 4)] });
    expect(spec.scenes[2]!.layers[0]!.type).toBe('plate');
  });

  it('places captions inside their beats, ordered, at least one frame each', () => {
    const spec = buildSpec({ id: 'v1', variant: variant(), beats: [beat(1, 3), beat(2, 4), beat(3, 5), beat(4, 4)] });
    expect(spec.captions.words).toHaveLength(8);
    expect(spec.captions.words[2]).toEqual({ text: 'w1', startFrame: 120 + 3, endFrame: 120 + 15 });
    expect(spec.captions.position).toBe('bottom_center'); // macro_texture
  });

  it('rejects a hero beat without a cutout key', () => {
    expect(() => buildSpec({ id: 'v1', variant: variant(), beats: [beat(1, 3), beat(2, 4), beat(3, 5, { cutout: undefined }), beat(4, 4)] })).toThrow(/cutout/);
  });

  it('drops zero-length tail words and always yields a schema-valid spec', () => {
    const tail = [{ text: 'w1', startSec: 0.1, endSec: 0.5 }, { text: 'end', startSec: 3, endSec: 3 }];
    const spec = buildSpec({ id: 'v1', variant: variant(), beats: [beat(1, 3, { words: tail }), beat(2, 4), beat(3, 5), beat(4, 4)] });
    expect(spec.captions.words.map((w) => w.text)).not.toContain('end');
    expect(spec.captions.words.every((w) => w.endFrame > w.startFrame)).toBe(true);
    expect(VideoSpec.safeParse(spec).success).toBe(true);
  });

  it('matches the golden spec', async () => {
    const spec = buildSpec({ id: 'v1', variant: variant(), beats: [beat(1, 3), beat(2, 4), beat(3, 5), beat(4, 4)] });
    await expect(JSON.stringify(spec, null, 2) + '\n').toMatchFileSnapshot('./golden/build-spec.json');
  });
});
