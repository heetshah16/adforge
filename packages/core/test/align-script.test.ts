import { describe, expect, it } from 'vitest';
import { alignScript } from '../src/spec/align-script';

const w = (text: string, startSec: number, endSec: number) => ({ text, startSec, endSec });
const valid = (out: { startSec: number; endSec: number }[], dur: number) => {
  let prev = 0;
  for (const x of out) {
    expect(x.startSec).toBeGreaterThanOrEqual(prev - 1e-9);
    expect(x.endSec).toBeGreaterThan(x.startSec);
    expect(x.endSec).toBeLessThanOrEqual(dur + 1e-9);
    prev = x.endSec;
  }
};

describe('alignScript', () => {
  it('uses ASR timings for matched words, keeping the script text and punctuation', () => {
    const out = alignScript('Nobody tells you, okay?', [w('nobody', 0.1, 0.4), w('tells', 0.4, 0.7), w('you', 0.7, 0.9), w('okay', 1.0, 1.4)], 2);
    expect(out).toEqual([w('Nobody', 0.1, 0.4), w('tells', 0.4, 0.7), w('you,', 0.7, 0.9), w('okay?', 1.0, 1.4)]);
  });

  it('interpolates script words Whisper missed between matched neighbours', () => {
    const out = alignScript('one two three four', [w('one', 0, 0.5), w('four', 1.5, 2)], 2);
    expect(out.map((x) => x.text)).toEqual(['one', 'two', 'three', 'four']);
    expect(out[1]!.startSec).toBeCloseTo(0.5, 6);
    expect(out[2]!.endSec).toBeCloseTo(1.5, 6);
    valid(out, 2);
  });

  it('falls back to proportional slots across the speech span when scripts differ (Hinglish → Devanagari ASR)', () => {
    const out = alignScript('Bilkul sahi oil hai', [w('बिल्कुल', 0.2, 0.6), w('सही', 0.6, 0.9), w('ऑयल', 0.9, 1.3), w('है', 1.3, 1.5)], 2);
    expect(out.map((x) => x.text)).toEqual(['Bilkul', 'sahi', 'oil', 'hai']);
    expect(out[0]!.startSec).toBeCloseTo(0.2, 6);
    expect(out.at(-1)!.endSec).toBeCloseTo(1.5, 6);
    valid(out, 2);
  });

  it('matches Devanagari script against Devanagari ASR', () => {
    const out = alignScript('असली स्वाद', [w('असली', 0.1, 0.5), w('स्वाद', 0.5, 0.9)], 1);
    expect(out).toEqual([w('असली', 0.1, 0.5), w('स्वाद', 0.5, 0.9)]);
  });

  it('spreads words over the whole clip when ASR returned nothing', () => {
    const out = alignScript('a bb ccc', [], 1.2);
    expect(out[0]!.startSec).toBe(0);
    expect(out.at(-1)!.endSec).toBeCloseTo(1.2, 6);
    valid(out, 1.2);
  });

  it('clamps ASR timings that run past the clip and keeps words monotonic', () => {
    const out = alignScript('a b', [w('a', 0.5, 0.4), w('b', 0.3, 9)], 1);
    valid(out, 1);
  });

  it('returns nothing for an empty script', () => {
    expect(alignScript('   ', [w('x', 0, 1)], 1)).toEqual([]);
  });

  it('handles more ASR words than script words, and fewer', () => {
    valid(alignScript('hello world', [w('hello', 0, 0.3), w('big', 0.3, 0.5), w('world', 0.5, 1)], 1), 1);
    valid(alignScript('hello big wide world', [w('hello', 0, 0.3), w('world', 0.7, 1)], 1), 1);
  });

  it('keeps punctuation-only tokens, never matching them, and stays valid', () => {
    const out = alignScript('wait — what', [w('wait', 0, 0.4), w('what', 0.5, 1)], 1);
    expect(out.map((x) => x.text)).toEqual(['wait', '—', 'what']);
    valid(out, 1);
  });

  it('stays finite for a zero-duration clip', () => {
    const out = alignScript('a b', [], 0);
    expect(out).toHaveLength(2);
    for (const x of out) expect(Number.isFinite(x.startSec) && Number.isFinite(x.endSec)).toBe(true);
  });
});
