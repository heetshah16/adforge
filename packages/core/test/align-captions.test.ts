import { describe, expect, it } from 'vitest';
import { alignCaptions } from '../src/spec/align-captions';

const w = (text: string, startSec: number, endSec: number) => ({ text, startSec, endSec });
const scene = { vo: 'Koi nahi batata', vo_tts: 'कोई नहीं बताता' } as Parameters<typeof alignCaptions>[0];

describe('alignCaptions', () => {
  it('hinglish: keeps Latin captions with timings from the Devanagari alignment when token counts match', () => {
    const asr = [w('कोई', 0.1, 0.4), w('नहीं', 0.5, 0.8), w('बताता', 0.9, 1.4)];
    expect(alignCaptions(scene, 'hinglish', asr, 2)).toEqual([w('Koi', 0.1, 0.4), w('nahi', 0.5, 0.8), w('batata', 0.9, 1.4)]);
  });

  it('hinglish: falls back to aligning the Latin vo when token counts differ', () => {
    const s = { vo: 'Koi nahi batata', vo_tts: 'कोई नहीं' } as typeof scene;
    const out = alignCaptions(s, 'hinglish', [], 3);
    expect(out.map((x) => x.text)).toEqual(['Koi', 'nahi', 'batata']);
    expect(out.at(-1)!.endSec).toBeLessThanOrEqual(3 + 1e-9);
  });

  it('other languages align vo directly', () => {
    const out = alignCaptions({ vo: 'Hello there' } as typeof scene, 'en', [w('hello', 0, 0.5), w('there', 0.5, 1)], 1);
    expect(out).toEqual([w('Hello', 0, 0.5), w('there', 0.5, 1)]);
  });
});
