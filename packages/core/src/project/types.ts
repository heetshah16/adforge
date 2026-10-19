import { z } from 'zod';
import type { DirectorVariant } from '../llm/schemas';
import { CAPTIONS_ID, LayerId, TextPosition, TextWeight } from '../spec/video-spec';

/**
 * When an element appears, bound to the soundtrack rather than to a frame: a VO edit that moves
 * words moves word-cued reveals with them. Resolved to an absolute `revealFrame` in compileProject;
 * the VideoSpec IR never holds cues. `word` indexes this scene's VO words.
 */
export const Cue = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('scene'), offsetFrames: z.number().int() }),
  z.object({ kind: z.literal('word'), word: z.number().int().nonnegative(), offsetFrames: z.number().int() }),
]);
export type Cue = z.infer<typeof Cue>;

/** Base layer ids are `s<i>.plate | .broll | .product | .headline` (i from 0); the captions target is `captions`. */
export const EditOp = z
  .discriminatedUnion('op', [
    z.object({ op: z.literal('move'), layerId: LayerId, x: z.number(), y: z.number() }),
    z.object({ op: z.literal('resize'), layerId: LayerId, w: z.number().positive(), h: z.number().positive() }),
    z.object({ op: z.literal('setText'), layerId: LayerId, content: z.string().min(1).max(60) }),
    z.object({
      op: z.literal('setStyle'),
      layerId: LayerId,
      style: z.object({ weight: TextWeight.optional(), scrim: z.boolean().optional(), position: TextPosition.optional() }),
    }),
    z.object({ op: z.literal('retime'), layerId: LayerId, reveal: Cue }),
    /** Re-generates assets in the executor; the compiled layout only sees the new beats. `format` is structural (C3). */
    z.object({ op: z.literal('setField'), beat: z.number().int().nonnegative(), path: z.enum(['vo', 'emotion', 'scene', 'format']), value: z.string() }),
    z.object({ op: z.literal('regenerate'), assetTag: z.string().regex(/^(plate|voice):\d+$/, 'expected plate:<beat> or voice:<beat>') }),
    z.object({ op: z.literal('lock') }),
    z.object({ op: z.literal('unlock') }),
  ])
  .refine((o) => o.op !== 'setStyle' || o.style.position === undefined || o.layerId === CAPTIONS_ID, {
    message: `style.position applies to the "${CAPTIONS_ID}" target only`,
  });
export type EditOp = z.infer<typeof EditOp>;

export interface ProjectBase {
  id: string;
  variant: DirectorVariant;
  theme: { primary: string; accent: string };
}

/** A generated ad as an editable project: the base generation plus its edit log, compiled by compileProject. */
export interface Project {
  base: ProjectBase;
  ops: EditOp[];
}
