import type { DirectorVariant } from '../llm/schemas';
import type { AlignedWord } from '../providers/types';
import type { Language } from '../vocab/enums';
import { alignScript } from './align-script';

const tokens = (s: string) => s.trim().split(/\s+/).filter(Boolean);

/**
 * Captions show `vo`; for hinglish the voice speaks Devanagari `vo_tts`, so ASR is aligned against that script and
 * its timings are re-labelled with the Latin tokens. Unequal token counts can't map 1:1 → align `vo` directly.
 */
export function alignCaptions(
  scene: DirectorVariant['scenes'][number],
  language: Language,
  asr: AlignedWord[],
  durationSec: number,
): AlignedWord[] {
  if (language === 'hinglish' && scene.vo_tts) {
    const latin = tokens(scene.vo);
    const timed = alignScript(scene.vo_tts, asr, durationSec);
    if (timed.length === latin.length) return timed.map((x, i) => ({ ...x, text: latin[i]! }));
  }
  return alignScript(scene.vo, asr, durationSec);
}
