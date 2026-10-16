import type { Language } from '../vocab/enums';
import type { DirectorVariant } from './schemas';

/** The line the voice engine speaks: Devanagari `vo_tts` for hinglish, otherwise `vo`. Captions keep `vo`. */
export function ttsText(scene: DirectorVariant['scenes'][number], language: Language): string {
  if (language !== 'hinglish') return scene.vo;
  if (!scene.vo_tts) throw new Error(`hinglish scene "${scene.beat}" is missing vo_tts (rules should have rejected it)`);
  return scene.vo_tts;
}
