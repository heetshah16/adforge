import { PIPELINE, type PipelineConfig } from '@adforge/core/config/pipeline';
import type { Language } from '@adforge/core/vocab/enums';

export type SynthBody = { text: string; language_id: 'en' | 'hi'; exaggeration: number; cfg_weight: number };

const ttsLanguage = (l: Language, cfg: PipelineConfig) => (l === 'hinglish' ? cfg.voice.hinglishTtsLanguage : l);
export const asrLanguage = (l: Language, cfg: PipelineConfig = PIPELINE): 'en' | 'hi' => (l === 'hinglish' ? cfg.voice.hinglishAsrLanguage : l);

/** Director emotion (0..1) → Chatterbox controls. Expressive lines get a lower cfg weight (Chatterbox README tip). */
export function voiceParams(text: string, language: Language, emotion: number, cfg: PipelineConfig = PIPELINE): SynthBody {
  const [lo, hi] = cfg.voice.exaggeration;
  const e = Math.min(1, Math.max(0, emotion));
  return {
    text,
    language_id: ttsLanguage(language, cfg),
    exaggeration: Number((lo + e * (hi - lo)).toFixed(6)),
    cfg_weight: e > cfg.voice.expressiveAbove ? cfg.voice.expressiveCfgWeight : cfg.voice.cfgWeight,
  };
}
