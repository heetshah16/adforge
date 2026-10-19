import type { PipelineConfig } from '../config/pipeline';
import type { DirectorVariant } from '../llm/schemas';
import { compileProject } from '../project/compile';
import type { AlignedWord } from '../providers/types';
import type { VideoSpec } from './video-spec';

export interface BeatAssets {
  plate: string;
  cutout?: string;
  broll?: { key: string; durationSec: number };
  voice: { key: string; durationSec: number };
  words: AlignedWord[];
}
export interface BuildSpecInput {
  id: string;
  variant: DirectorVariant;
  beats: BeatAssets[];
  theme?: { primary: string; accent: string };
  cfg?: PipelineConfig;
}

export const DEFAULT_THEME = { primary: '#141414', accent: '#f5b301' };

/** Director variant + generated assets → our IR: the project with no edits (compileProject holds the layout). */
export function buildSpec(input: BuildSpecInput): VideoSpec {
  return compileProject({ base: { id: input.id, variant: input.variant, theme: input.theme ?? DEFAULT_THEME }, ops: [] }, input.beats, input.cfg).spec;
}
