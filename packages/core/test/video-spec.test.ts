import { describe, expect, it } from 'vitest';
import { VideoSpec } from '../src/spec/video-spec';

const KEY_PNG = `ab/${'a'.repeat(64)}.png`;
const KEY_CUT = `cd/${'c'.repeat(64)}.png`;
const KEY_MP4 = `ef/${'e'.repeat(64)}.mp4`;
const KEY_WAV = `12/${'1'.repeat(64)}.wav`;

function valid() {
  return {
    id: 'job1-v1',
    width: 1080,
    height: 1920,
    fps: 30,
    durationInFrames: 60,
    theme: { primary: '#111111', accent: '#ffcc00' },
    scenes: [
      {
        startFrame: 0,
        durationInFrames: 30,
        motion: 'slow_zoom_in',
        layers: [
          { type: 'plate', key: KEY_PNG },
          { type: 'cutout', key: KEY_CUT, anchorX: 0.5, anchorY: 0.86, heightFrac: 0.42, shadow: true },
          { type: 'text', content: '3-day results', position: 'top_third', weight: 'bold', scrim: false },
        ],
      },
      {
        startFrame: 30,
        durationInFrames: 30,
        motion: 'static',
        layers: [{ type: 'video', key: KEY_MP4, trimStartFrame: 0 }],
      },
    ],
    audio: { voice: [{ key: KEY_WAV, startFrame: 0, durationInFrames: 50 }] },
    captions: {
      position: 'bottom_center',
      words: [
        { text: 'Stop', startFrame: 0, endFrame: 10 },
        { text: 'buying', startFrame: 10, endFrame: 20 },
      ],
    },
  };
}

const issues = (v: unknown) => {
  const r = VideoSpec.safeParse(v);
  return r.success ? [] : r.error.issues.map((i) => i.message);
};

describe('VideoSpec', () => {
  it('accepts a valid spec', () => {
    expect(issues(valid())).toEqual([]);
  });

  it('requires contiguous scenes starting at 0 that sum to durationInFrames', () => {
    const gap = valid();
    gap.scenes[1]!.startFrame = 31;
    expect(issues(gap).join()).toMatch(/contiguous/);
    const short = valid();
    short.durationInFrames = 61;
    expect(issues(short).join()).toMatch(/sum/);
  });

  it('requires the first layer of a scene to be a plate or a video background', () => {
    const s = valid();
    s.scenes[0]!.layers = [{ type: 'text', content: 'x', position: 'top_third', weight: 'bold', scrim: false }];
    expect(issues(s).join()).toMatch(/background/);
  });

  it('allows at most one video layer per scene and no video alongside a plate', () => {
    const s = valid();
    s.scenes[0]!.layers.push({ type: 'video', key: KEY_MP4, trimStartFrame: 0 } as never);
    expect(issues(s).join()).toMatch(/video/);
  });

  it('keeps voice and caption timing inside the video', () => {
    const v = valid();
    v.audio.voice[0]!.durationInFrames = 61;
    expect(issues(v).join()).toMatch(/voice/);
    const c = valid();
    c.captions.words[1]!.endFrame = 61;
    expect(issues(c).join()).toMatch(/caption/);
  });

  it('requires caption words ordered, non-overlapping, and non-empty in time', () => {
    const overlap = valid();
    overlap.captions.words[1]!.startFrame = 5;
    expect(issues(overlap).join()).toMatch(/caption/);
    const empty = valid();
    empty.captions.words[0]!.endFrame = 0;
    expect(issues(empty).join()).toMatch(/caption/);
  });

  it('rejects URLs where storage keys belong', () => {
    const s = valid();
    (s.scenes[0]!.layers[0] as { key: string }).key = 'http://localhost:3000/media/ab/x.png';
    expect(issues(s).length).toBeGreaterThan(0);
  });

  it('bounds cutout geometry and text length', () => {
    const s = valid();
    (s.scenes[0]!.layers[1] as { heightFrac: number }).heightFrac = 1.5;
    expect(issues(s).length).toBeGreaterThan(0);
    const t = valid();
    (t.scenes[0]!.layers[2] as { content: string }).content = 'x'.repeat(61);
    expect(issues(t).length).toBeGreaterThan(0);
  });
});
