import { z } from 'zod';
import { STORAGE_KEY_RE } from '../providers/storage-key';
import { Motion } from '../vocab/enums';

/** Our IR. Frames are the source of truth; layers reference storage keys, never URLs. */
export const StorageKey = z.string().regex(STORAGE_KEY_RE, 'expected a storage key');
const Frame = z.number().int().nonnegative();
const PositiveFrames = z.number().int().positive();
const Frac = z.number().min(0).max(1);
const Hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);

export const TextPosition = z.enum(['top_third', 'mid_lower', 'bottom_center']);
export type TextPosition = z.infer<typeof TextPosition>;
export const TextWeight = z.enum(['regular', 'bold', 'chunky']);
export type TextWeight = z.infer<typeof TextWeight>;

const PlateLayer = z.object({ type: z.literal('plate'), key: StorageKey });
/** Real product pixels (T0). Anchored by its bottom-centre point, as fractions of the frame. */
const CutoutLayer = z.object({
  type: z.literal('cutout'),
  key: StorageKey,
  anchorX: Frac,
  anchorY: Frac,
  heightFrac: z.number().gt(0).max(1),
  shadow: z.boolean(),
});
/** Fills its scene; trimStartFrame is the offset into the source clip. */
const VideoLayer = z.object({ type: z.literal('video'), key: StorageKey, trimStartFrame: Frame });
const TextLayer = z.object({
  type: z.literal('text'),
  content: z.string().min(1).max(60),
  position: TextPosition,
  weight: TextWeight,
  scrim: z.boolean(),
});
export const Layer = z.discriminatedUnion('type', [PlateLayer, CutoutLayer, VideoLayer, TextLayer]);
export type Layer = z.infer<typeof Layer>;

export const Scene = z.object({
  startFrame: Frame,
  durationInFrames: PositiveFrames,
  /** Applied identically to the plate and the cutout so the product stays locked to the scene. */
  motion: Motion,
  layers: z.array(Layer).min(1),
});
export type Scene = z.infer<typeof Scene>;

const Word = z.object({ text: z.string().min(1).max(40), startFrame: Frame, endFrame: Frame });

export const VideoSpec = z
  .object({
    id: z.string().min(1),
    width: PositiveFrames,
    height: PositiveFrames,
    fps: z.literal(30),
    durationInFrames: PositiveFrames,
    theme: z.object({ primary: Hex, accent: Hex }),
    scenes: z.array(Scene).min(1),
    audio: z.object({
      voice: z.array(z.object({ key: StorageKey, startFrame: Frame, durationInFrames: PositiveFrames })),
    }),
    captions: z.object({ position: TextPosition, words: z.array(Word) }),
  })
  .superRefine((s, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: 'custom', message });

    let cursor = 0;
    for (const [i, scene] of s.scenes.entries()) {
      if (scene.startFrame !== cursor) issue(`scenes must be contiguous from frame 0: scene ${i} starts at ${scene.startFrame}, expected ${cursor}`);
      cursor = scene.startFrame + scene.durationInFrames;

      const bg = scene.layers[0]?.type;
      if (bg !== 'plate' && bg !== 'video') issue(`scene ${i}: first layer must be a plate or video background`);
      const videos = scene.layers.filter((l) => l.type === 'video').length;
      const plates = scene.layers.filter((l) => l.type === 'plate').length;
      if (videos > 1 || (videos === 1 && plates > 0)) issue(`scene ${i}: at most one video layer, and never together with a plate`);
      if (videos > 0 && scene.motion !== 'static') issue(`scene ${i}: a video-background scene must use motion 'static' (b-roll is not motion-staged)`);
    }
    if (cursor !== s.durationInFrames) issue(`scene durations sum to ${cursor}, expected durationInFrames ${s.durationInFrames}`);

    for (const [i, v] of s.audio.voice.entries()) {
      if (v.startFrame + v.durationInFrames > s.durationInFrames) issue(`voice track ${i} ends after the video`);
    }

    let prevEnd = 0;
    for (const [i, w] of s.captions.words.entries()) {
      if (w.endFrame <= w.startFrame) issue(`caption word ${i} has no duration`);
      if (w.startFrame < prevEnd) issue(`caption word ${i} overlaps the previous word`);
      if (w.endFrame > s.durationInFrames) issue(`caption word ${i} ends after the video`);
      prevEnd = w.endFrame;
    }
  });
export type VideoSpec = z.infer<typeof VideoSpec>;
