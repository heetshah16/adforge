import { describe, expect, it } from 'vitest';
import { layoutFrames, secondsToFrames } from '../src/spec/frames';

describe('secondsToFrames', () => {
  it('converts at 30fps', () => {
    expect(secondsToFrames(2, 30)).toBe(60);
    expect(secondsToFrames(0, 30)).toBe(0);
  });
  it('rejects negative and non-finite input', () => {
    expect(() => secondsToFrames(-1, 30)).toThrow(RangeError);
    expect(() => secondsToFrames(Number.NaN, 30)).toThrow(RangeError);
  });
});

describe('layoutFrames', () => {
  it('has no cumulative drift where per-segment rounding would add frames', () => {
    // 0.25s @30fps = 7.5 frames; rounding each segment alone gives 8×4 = 32, not 30.
    const out = layoutFrames([0.25, 0.25, 0.25, 0.25], 30);
    const total = out.reduce((n, s) => n + s.durationInFrames, 0);
    expect(total).toBe(30);
  });
  it('produces contiguous segments starting at 0', () => {
    const out = layoutFrames([3.5, 5.5, 5.5, 5.5], 30);
    expect(out[0]?.startFrame).toBe(0);
    for (let i = 1; i < out.length; i++) {
      const prev = out[i - 1]!;
      expect(out[i]!.startFrame).toBe(prev.startFrame + prev.durationInFrames);
    }
    expect(out.at(-1)!.startFrame + out.at(-1)!.durationInFrames).toBe(600);
  });
});
