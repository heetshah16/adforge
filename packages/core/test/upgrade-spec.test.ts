import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readSpec, upgradeSpec } from '../src/spec/upgrade-spec';
import { VideoSpec, VideoSpecV1 } from '../src/spec/video-spec';

const v1Base = () => VideoSpecV1.parse(JSON.parse(readFileSync(new URL('./golden/compile-base.json', import.meta.url), 'utf8')));
const issues = (v: unknown) => {
  const r = VideoSpec.safeParse(v);
  return r.success ? [] : r.error.issues.map((i) => i.message);
};

describe('upgradeSpec', () => {
  const v2 = upgradeSpec(v1Base());

  it('yields a valid v2 spec with the same timing, audio and words', () => {
    const v1 = v1Base();
    expect(issues(v2)).toEqual([]);
    expect(v2.version).toBe(2);
    expect(v2.durationInFrames).toBe(v1.durationInFrames);
    expect(v2.scenes.map((s) => [s.startFrame, s.durationInFrames, s.motion, s.transitionIn])).toEqual(
      v1.scenes.map((s) => [s.startFrame, s.durationInFrames, s.motion, 'cut']),
    );
    expect(v2.audio).toEqual({ voice: v1.audio.voice, music: [], sfx: [] });
    expect(v2.captions).toEqual({ position: v1.captions.position, style: { weight: 'bold' }, words: v1.captions.words });
  });

  it('maps every layer with ids, z in layer order, and reveal at scene start', () => {
    expect(v2.scenes.map((s) => s.layers.map((l) => l.layerId))).toEqual([
      ['s0.broll', 's0.headline'],
      ['s1.plate', 's1.product', 's1.headline'],
      ['s2.plate', 's2.product', 's2.headline'],
      ['s3.plate', 's3.product', 's3.headline'],
    ]);
    for (const s of v2.scenes) {
      expect(s.layers.map((l) => l.z)).toEqual(s.layers.map((_, z) => z));
      expect(s.layers.every((l) => l.revealFrame === s.startFrame)).toBe(true);
    }
    expect(v2.scenes[0]!.layers[0]).toMatchObject({ type: 'broll', box: { x: 0, y: 0, w: 1, h: 1 }, trimStartFrame: 0 });
    expect(v2.scenes[1]!.layers[0]).toMatchObject({ type: 'plate', box: { x: 0, y: 0, w: 1, h: 1 } });
  });

  it('maps a cutout anchor to a bottom-centre product box, exceeding the frame horizontally when needed', () => {
    // supporting: anchorX 0.72, anchorY 0.9, heightFrac 0.3
    const p = v2.scenes[1]!.layers[1]!;
    expect(p).toMatchObject({ type: 'product', shadow: true, key: `cc/${'c'.repeat(64)}.png` });
    if (p.type !== 'product') throw new Error('expected product');
    expect(p.box.x).toBeCloseTo(0.22, 12);
    expect(p.box.y).toBeCloseTo(0.6, 12);
    expect(p.box.w).toBe(1);
    expect(p.box.h).toBe(0.3);
    expect(p.box.x + p.box.w).toBeGreaterThan(1);
  });

  it('maps a text position to a headline box and keeps weight and scrim', () => {
    const h = v2.scenes[0]!.layers[1]!;
    expect(h).toMatchObject({ type: 'headline', box: { x: 0.06, y: 0.14, w: 0.88, h: 0.2 }, style: { weight: 'bold', scrim: true } });
    const mk = (position: 'top_third' | 'mid_lower' | 'bottom_center') => {
      const v1 = v1Base();
      v1.scenes[0]!.layers[1] = { type: 'text', content: 'x', position, weight: 'regular', scrim: false };
      return upgradeSpec(v1).scenes[0]!.layers[1]!.box;
    };
    expect([mk('top_third').y, mk('mid_lower').y, mk('bottom_center').y]).toEqual([0.14, 0.58, 0.74]);
  });

  it('suffixes repeated layer kinds in one scene so ids stay unique', () => {
    const v1 = v1Base();
    v1.scenes[1]!.layers.push({ type: 'text', content: 'second', position: 'mid_lower', weight: 'bold', scrim: false });
    expect(upgradeSpec(v1).scenes[1]!.layers.map((l) => l.layerId)).toEqual(['s1.plate', 's1.product', 's1.headline', 's1.headline.1']);
  });

  it('readSpec accepts v2 as-is and upgrades a stored v1 row', () => {
    expect(readSpec(v1Base())).toEqual(v2);
    expect(readSpec(v2)).toEqual(v2);
    expect(() => readSpec({ id: 'x' })).toThrow();
  });
});

describe('VideoSpec v2 rules', () => {
  const v2 = () => structuredClone(upgradeSpec(v1Base()));

  it('carries the v1 rules over', () => {
    const gap = v2();
    gap.scenes[1]!.startFrame += 1;
    expect(issues(gap).join()).toMatch(/contiguous/);
    const bg = v2();
    bg.scenes[1]!.layers.reverse();
    expect(issues(bg).join()).toMatch(/background/);
    const under = v2();
    under.scenes[1]!.layers[2]!.z = -1; // headline beneath the plate
    expect(issues(under).join()).toMatch(/lowest z/);
    const both = v2();
    both.scenes[1]!.layers.push({ ...both.scenes[0]!.layers[0]!, layerId: 's1.broll' });
    expect(issues(both).join()).toMatch(/broll/);
    const moving = v2();
    moving.scenes[0]!.motion = 'slow_pan';
    expect(issues(moving).join()).toMatch(/static/);
    const overlap = v2();
    overlap.captions.words[1]!.startFrame = overlap.captions.words[0]!.startFrame;
    expect(issues(overlap).join()).toMatch(/overlaps/);
    const longVoice = v2();
    longVoice.audio.voice[3]!.durationInFrames = 999;
    expect(issues(longVoice).join()).toMatch(/voice/);
  });

  it('requires revealFrame inside its scene', () => {
    const late = v2();
    const s = late.scenes[1]!;
    s.layers[2]!.revealFrame = s.startFrame + s.durationInFrames;
    expect(issues(late).join()).toMatch(/revealFrame/);
    const early = v2();
    early.scenes[1]!.layers[2]!.revealFrame = early.scenes[1]!.startFrame - 1;
    expect(issues(early).join()).toMatch(/revealFrame/);
  });

  it('requires layer ids unique across the spec, and never "captions"', () => {
    const dup = v2();
    dup.scenes[2]!.layers[2]!.layerId = 's1.headline';
    expect(issues(dup).join()).toMatch(/unique/);
    const cap = v2();
    cap.scenes[2]!.layers[2]!.layerId = 'captions';
    expect(issues(cap).join()).toMatch(/captions/);
    const bad = v2();
    bad.scenes[2]!.layers[2]!.layerId = 'S2 Headline';
    expect(issues(bad).length).toBeGreaterThan(0);
  });

  it('keeps non-product boxes inside the frame; only product boxes may exceed it horizontally', () => {
    const wide = v2();
    wide.scenes[1]!.layers[2]!.box.x = 0.2; // 0.2 + 0.88 > 1
    expect(issues(wide).length).toBeGreaterThan(0);
    const low = v2();
    low.scenes[1]!.layers[1]!.box.y = 0.8; // product: 0.8 + 0.3 > 1
    expect(issues(low).length).toBeGreaterThan(0);
    const off = v2();
    off.scenes[1]!.layers[1]!.box.x = 0.6; // product bottom-centre at 1.1, off-frame
    expect(issues(off).length).toBeGreaterThan(0);
    const left = v2();
    left.scenes[2]!.layers[1]!.box.x = -0.4; // product bottom-centre at 0.1
    expect(issues(left)).toEqual([]);
  });

  it('keeps music and sfx tracks inside the video', () => {
    const m = v2();
    m.audio.music.push({ key: m.audio.voice[0]!.key, startFrame: 0, durationInFrames: m.durationInFrames + 1, gainDb: -12 });
    expect(issues(m).join()).toMatch(/music/);
  });
});
