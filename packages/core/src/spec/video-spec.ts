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

const Word = z.object({ text: z.string().min(1).max(40), startFrame: Frame, endFrame: Frame });
const Theme = z.object({ primary: Hex, accent: Hex });
const VoiceTrack = z.object({ key: StorageKey, startFrame: Frame, durationInFrames: PositiveFrames });

type Issue = (message: string) => void;

/** Rules shared by v1 and v2: contiguous scenes, voice and words inside the video, no overlapping words. */
function timingRules(
  s: { durationInFrames: number; scenes: { startFrame: number; durationInFrames: number }[]; audio: { voice: z.infer<typeof VoiceTrack>[] }; captions: { words: z.infer<typeof Word>[] } },
  issue: Issue,
) {
  let cursor = 0;
  for (const [i, scene] of s.scenes.entries()) {
    if (scene.startFrame !== cursor) issue(`scenes must be contiguous from frame 0: scene ${i} starts at ${scene.startFrame}, expected ${cursor}`);
    cursor = scene.startFrame + scene.durationInFrames;
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
}

// ─── v1 (frozen: stored `variants.spec` rows before C2; read them through upgradeSpec) ───

const PlateLayerV1 = z.object({ type: z.literal('plate'), key: StorageKey });
/** Real product pixels (T0). Anchored by its bottom-centre point, as fractions of the frame. */
const CutoutLayerV1 = z.object({
  type: z.literal('cutout'),
  key: StorageKey,
  anchorX: Frac,
  anchorY: Frac,
  heightFrac: z.number().gt(0).max(1),
  shadow: z.boolean(),
});
/** Fills its scene; trimStartFrame is the offset into the source clip. */
const VideoLayerV1 = z.object({ type: z.literal('video'), key: StorageKey, trimStartFrame: Frame });
const TextLayerV1 = z.object({
  type: z.literal('text'),
  content: z.string().min(1).max(60),
  position: TextPosition,
  weight: TextWeight,
  scrim: z.boolean(),
});
export const LayerV1 = z.discriminatedUnion('type', [PlateLayerV1, CutoutLayerV1, VideoLayerV1, TextLayerV1]);
export type LayerV1 = z.infer<typeof LayerV1>;

const SceneV1 = z.object({ startFrame: Frame, durationInFrames: PositiveFrames, motion: Motion, layers: z.array(LayerV1).min(1) });

export const VideoSpecV1 = z
  .object({
    id: z.string().min(1),
    width: PositiveFrames,
    height: PositiveFrames,
    fps: z.literal(30),
    durationInFrames: PositiveFrames,
    theme: Theme,
    scenes: z.array(SceneV1).min(1),
    audio: z.object({ voice: z.array(VoiceTrack) }),
    captions: z.object({ position: TextPosition, words: z.array(Word) }),
  })
  .superRefine((s, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
    timingRules(s, issue);
    for (const [i, scene] of s.scenes.entries()) {
      const bg = scene.layers[0]?.type;
      if (bg !== 'plate' && bg !== 'video') issue(`scene ${i}: first layer must be a plate or video background`);
      const videos = scene.layers.filter((l) => l.type === 'video').length;
      const plates = scene.layers.filter((l) => l.type === 'plate').length;
      if (videos > 1 || (videos === 1 && plates > 0)) issue(`scene ${i}: at most one video layer, and never together with a plate`);
      if (videos > 0 && scene.motion !== 'static') issue(`scene ${i}: a video-background scene must use motion 'static' (b-roll is not motion-staged)`);
    }
  });
export type VideoSpecV1 = z.infer<typeof VideoSpecV1>;

// ─── v2: element layers ───

const EPS = 1e-9; // box sums are float: 0.12 + 0.88 must still fit

/** A rectangle in frame fractions. Must lie inside the frame. */
export const Box = z
  .object({ x: Frac, y: Frac, w: z.number().gt(0).max(1), h: z.number().gt(0).max(1) })
  .refine((b) => b.x + b.w <= 1 + EPS && b.y + b.h <= 1 + EPS, 'box must lie inside the frame (x + w ≤ 1, y + h ≤ 1)');
export type Box = z.infer<typeof Box>;

/**
 * The product box is the ONLY box exempt from x + w ≤ 1: it may exceed the frame horizontally.
 * It renders anchored at its bottom-centre (x + w/2, y + h) with height h and natural width, the
 * v1 cutout's {anchorX, anchorY, heightFrac}. So the invariant is on that anchor: it stays in frame.
 */
const ProductBox = z
  .object({ x: z.number().min(-1).max(1), y: Frac, w: z.number().gt(0).max(2), h: z.number().gt(0).max(1) })
  .refine((b) => b.y + b.h <= 1 + EPS, 'product box must end inside the frame (y + h ≤ 1)')
  .refine((b) => b.x + b.w / 2 >= -EPS && b.x + b.w / 2 <= 1 + EPS, 'product box bottom-centre must lie inside the frame');

export const LAYER_ID_RE = /^[a-z0-9_.:-]{1,64}$/;
export const LayerId = z.string().regex(LAYER_ID_RE, 'expected a layer id');
/** The edit target for the captions track. Reserved: no element may take it. */
export const CAPTIONS_ID = 'captions';

/** `revealFrame` is absolute; the element shows from it to its scene's end. */
const El = { layerId: LayerId, box: Box, z: z.number().int(), revealFrame: Frame };
export const TextStyle = z.object({ weight: TextWeight, scrim: z.boolean() });
const text = <T extends string>(type: T) => z.object({ type: z.literal(type), ...El, content: z.string().min(1).max(60), style: TextStyle });

/** Render-coupled, closed: adding an element type is a PR with compositor code behind it. */
export const ElementLayer = z.discriminatedUnion('type', [
  z.object({ type: z.literal('plate'), ...El, key: StorageKey }),
  /** trimStartFrame is the offset into the source clip. */
  z.object({ type: z.literal('broll'), ...El, key: StorageKey, trimStartFrame: Frame }),
  /** Real product pixels (T0), never model-rendered. */
  z.object({ type: z.literal('product'), ...El, box: ProductBox, key: StorageKey, shadow: z.boolean() }),
  z.object({ type: z.literal('logo'), ...El, key: StorageKey }),
  text('headline'),
  text('stat'),
  text('chip'),
  text('badge'),
  text('cta_button'),
]);
export type ElementLayer = z.infer<typeof ElementLayer>;
export const TEXT_ELEMENTS = ['headline', 'stat', 'chip', 'badge', 'cta_button'] as const;
export type TextElement = Extract<ElementLayer, { type: (typeof TEXT_ELEMENTS)[number] }>;
export const isText = (l: ElementLayer): l is TextElement => (TEXT_ELEMENTS as readonly string[]).includes(l.type);

export const Scene = z.object({
  startFrame: Frame,
  durationInFrames: PositiveFrames,
  /** Applied identically to the plate and the product so the product stays locked to the scene. */
  motion: Motion,
  /** Closed: C4 adds transitions by PR. */
  transitionIn: z.enum(['cut']),
  layers: z.array(ElementLayer).min(1),
});
export type Scene = z.infer<typeof Scene>;

export const Track = z.object({ key: StorageKey, startFrame: Frame, durationInFrames: PositiveFrames, gainDb: z.number().min(-60).max(12) });
export type Track = z.infer<typeof Track>;

export const VideoSpec = z
  .object({
    version: z.literal(2),
    id: z.string().min(1),
    width: PositiveFrames,
    height: PositiveFrames,
    fps: z.literal(30),
    durationInFrames: PositiveFrames,
    theme: Theme,
    scenes: z.array(Scene).min(1),
    audio: z.object({ voice: z.array(VoiceTrack), music: z.array(Track), sfx: z.array(Track) }),
    captions: z.object({ position: TextPosition, style: z.object({ weight: TextWeight }), words: z.array(Word) }),
  })
  .superRefine((s, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
    timingRules(s, issue);

    const ids = new Set<string>();
    for (const [i, scene] of s.scenes.entries()) {
      const bg = scene.layers[0]?.type;
      if (bg !== 'plate' && bg !== 'broll') issue(`scene ${i}: first layer must be a plate or broll background`);
      const brolls = scene.layers.filter((l) => l.type === 'broll').length;
      const plates = scene.layers.filter((l) => l.type === 'plate').length;
      if (brolls > 1 || (brolls === 1 && plates > 0)) issue(`scene ${i}: at most one broll layer, and never together with a plate`);
      if (brolls > 0 && scene.motion !== 'static') issue(`scene ${i}: a broll scene must use motion 'static' (b-roll is not motion-staged)`);

      const end = scene.startFrame + scene.durationInFrames;
      for (const l of scene.layers) {
        if (l.revealFrame < scene.startFrame || l.revealFrame >= end) issue(`${l.layerId}: revealFrame ${l.revealFrame} is outside its scene [${scene.startFrame}, ${end})`);
        if (l.layerId === CAPTIONS_ID) issue(`layer id "${CAPTIONS_ID}" is reserved for the captions track`);
        else if (ids.has(l.layerId)) issue(`layer ids must be unique across the spec: "${l.layerId}" repeats`);
        ids.add(l.layerId);
      }
    }

    for (const kind of ['music', 'sfx'] as const) {
      for (const [i, t] of s.audio[kind].entries()) {
        if (t.startFrame + t.durationInFrames > s.durationInFrames) issue(`${kind} track ${i} ends after the video`);
      }
    }
  });
export type VideoSpec = z.infer<typeof VideoSpec>;
