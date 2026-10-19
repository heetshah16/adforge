import { describe, expect, it } from 'vitest';
import { createMediaRefresh, retrySrc } from '../lib/use-media-url';

class FakeVideo extends EventTarget {
  currentTime = 0;
  paused = true;
  plays = 0;
  play() { this.paused = false; this.plays++; return Promise.resolve(); }
}
const setup = (base = '/media/org/o/ab/x.mp4') => {
  const seen: { src: string; failed: boolean }[] = [];
  const r = createMediaRefresh(base, (s) => seen.push(s));
  const el = new FakeVideo();
  r.ref(el as unknown as HTMLVideoElement);
  return { r, el, seen };
};

describe('useMediaUrl core', () => {
  it('retrySrc appends r=n', () => {
    expect(retrySrc('/media/a', 1)).toBe('/media/a?r=1');
    expect(retrySrc('/media/a?x=1', 2)).toBe('/media/a?x=1&r=2');
  });
  it('an error at currentTime 7.5 while playing -> ?r=1, then time restored and play() after loadedmetadata', () => {
    const { r, el, seen } = setup();
    el.currentTime = 7.5; el.paused = false;
    r.onError();
    expect(seen.at(-1)).toEqual({ src: '/media/org/o/ab/x.mp4?r=1', failed: false });
    el.currentTime = 0; el.paused = true; // browser reloads from scratch
    expect(el.plays).toBe(0);
    el.dispatchEvent(new Event('loadedmetadata'));
    expect(el.currentTime).toBe(7.5);
    expect(el.plays).toBe(1);
  });
  it('a paused element is restored but not played', () => {
    const { r, el } = setup();
    el.currentTime = 3;
    r.onError();
    el.currentTime = 0;
    el.dispatchEvent(new Event('loadedmetadata'));
    expect([el.currentTime, el.plays]).toEqual([3, 0]);
  });
  it('the 4th error does not change src and reports failed', () => {
    const { r, seen } = setup();
    r.onError(); r.onError(); r.onError();
    expect(seen.map((s) => s.src).at(-1)).toBe('/media/org/o/ab/x.mp4?r=3');
    const count = seen.length;
    r.onError();
    expect(seen.slice(0, count)).toHaveLength(count);
    expect(seen.at(-1)).toEqual({ src: '/media/org/o/ab/x.mp4?r=3', failed: true });
  });
});
