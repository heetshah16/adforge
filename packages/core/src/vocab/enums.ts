import { z } from 'zod';

/**
 * Render-coupled dimensions: closed by design. Every value needs renderer code
 * and a TREATMENTS entry, so adding one is a PR, not a data change (architecture §5.1).
 */
export const VisualTreatment = z.enum([
  'clean_studio',
  'lifestyle_context',
  'macro_texture',
  'hand_held_ugc',
  'flat_lay',
  'split_compare',
]);
export type VisualTreatment = z.infer<typeof VisualTreatment>;

export const Motion = z.enum(['slow_zoom_in', 'slow_zoom_out', 'slow_pan', 'subtle_shake', 'static']);
export type Motion = z.infer<typeof Motion>;

/** Drives fidelityTier in code: hero|supporting → T0 cutout overlay; absent → T2. */
export const ProductProminence = z.enum(['hero', 'supporting', 'absent']);
export type ProductProminence = z.infer<typeof ProductProminence>;

/** Voice-over language per job (spec §11). On-screen claim text stays Latin script for all. */
export const Language = z.enum(['en', 'hi', 'hinglish']);
export type Language = z.infer<typeof Language>;
