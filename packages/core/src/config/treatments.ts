import type { Motion, VisualTreatment } from '../vocab/enums';

export interface TreatmentConfig {
  captionPosition: 'bottom_center' | 'mid_lower' | 'top_third';
  captionWeight: 'regular' | 'bold' | 'chunky';
  scrim: boolean;
  defaultMotion: Motion;
  /** Appended to every plate prompt for this treatment. Plates never contain the product. */
  platePromptSuffix: string;
}

/** Build spec §3 Axis 3 mapping. `satisfies` makes a missing treatment a compile error. */
export const TREATMENTS = {
  clean_studio: {
    captionPosition: 'bottom_center',
    captionWeight: 'regular',
    scrim: false,
    defaultMotion: 'slow_zoom_in',
    platePromptSuffix:
      'seamless soft light-grey studio backdrop, gentle gradient, softbox lighting, minimal commercial product photography, empty centre foreground',
  },
  lifestyle_context: {
    captionPosition: 'bottom_center',
    captionWeight: 'regular',
    scrim: true,
    defaultMotion: 'slow_pan',
    platePromptSuffix:
      'warm natural daylight, real lived-in interior, shallow depth of field, candid editorial photography, empty surface in the foreground',
  },
  macro_texture: {
    captionPosition: 'bottom_center',
    captionWeight: 'bold',
    scrim: true,
    defaultMotion: 'slow_zoom_in',
    platePromptSuffix:
      'extreme macro detail, tactile surface texture, dramatic raking light, very shallow depth of field',
  },
  hand_held_ugc: {
    captionPosition: 'mid_lower',
    captionWeight: 'chunky',
    scrim: false,
    defaultMotion: 'subtle_shake',
    platePromptSuffix:
      'smartphone photo look, casual everyday setting, natural window light, slightly imperfect framing',
  },
  flat_lay: {
    captionPosition: 'top_third',
    captionWeight: 'regular',
    scrim: false,
    defaultMotion: 'slow_zoom_out',
    platePromptSuffix:
      'top-down flat lay on a textured surface, styled props arranged at the edges, soft even light, empty centre',
  },
  split_compare: {
    captionPosition: 'top_third',
    captionWeight: 'bold',
    scrim: false,
    defaultMotion: 'static',
    platePromptSuffix: 'clean dark backdrop, dramatic rim light, strong contrast, empty centre',
  },
} satisfies Record<VisualTreatment, TreatmentConfig>;
