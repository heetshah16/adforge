import { loadPrompt } from '../src/llm/prompts';
import type { DirectorOutput, DirectorVariant } from '../src/llm/schemas';
import type { BeatAssets } from '../src/spec/build-spec';

/** The Director prompt's few-shot variant 1 (absent, absent, hero, hero), with beat 1 made `supporting` (covers that box) and 2 s long. */
export function compileVariant(): DirectorVariant {
  const t = loadPrompt('director').text;
  const v = (JSON.parse(t.slice(t.indexOf('```json') + 7, t.lastIndexOf('```'))) as DirectorOutput).variants[0]!;
  v.scenes[1]!.product_prominence = 'supporting';
  v.scenes[1]!.duration = 2; // voice-driven, so a longer VO line grows the scene (Review Focus 3)
  return v;
}

export const key = (c: string, ext = 'png') => `${c}${c}/${c.repeat(64)}.${ext}`;

export const beat = (i: number, voiceSec: number, extra: Partial<BeatAssets> = {}): BeatAssets => ({
  plate: key(String(i)),
  cutout: key('c'),
  voice: { key: key(String(i), 'wav'), durationSec: voiceSec },
  words: [
    { text: 'w1', startSec: 0.1, endSec: 0.5 },
    { text: 'w2', startSec: 0.5, endSec: 1.0 },
    { text: 'w3', startSec: 1.0, endSec: 1.6 },
  ],
  ...extra,
});

/** Beat 0 carries b-roll long enough to cover it, so the base includes a b-roll scene. */
export const compileBeats = (): BeatAssets[] => [
  beat(1, 3, { broll: { key: key('b', 'mp4'), durationSec: 5.04 } }),
  beat(2, 2),
  beat(3, 5),
  beat(4, 4),
];
