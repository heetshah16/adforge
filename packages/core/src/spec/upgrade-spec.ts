import { VideoSpec, VideoSpecV1, type Box, type ElementLayer, type LayerV1, type TextPosition } from './video-spec';

/**
 * The v1 → v2 geometry. Pixel-identity-critical: the compositor renders these boxes to exactly
 * the CSS v1 produced (pinned by renderer-hyperframes/test/v2-identity.test.ts).
 */
export const FULL_FRAME: Box = { x: 0, y: 0, w: 1, h: 1 };
export const TEXT_BOX: Record<TextPosition, Box> = {
  top_third: { x: 0.06, y: 0.14, w: 0.88, h: 0.2 },
  mid_lower: { x: 0.06, y: 0.58, w: 0.88, h: 0.2 },
  bottom_center: { x: 0.06, y: 0.74, w: 0.88, h: 0.2 },
};
/** A bottom-centre anchor becomes a box whose bottom-centre is that anchor (w 1, so it may exceed the frame horizontally). */
export const productBox = (a: { anchorX: number; anchorY: number; heightFrac: number }): Box => ({
  x: a.anchorX - 0.5,
  y: a.anchorY - a.heightFrac,
  w: 1,
  h: a.heightFrac,
});

const KIND: Record<LayerV1['type'], string> = { plate: 'plate', video: 'broll', cutout: 'product', text: 'headline' };

function upgradeLayer(l: LayerV1, layerId: string, z: number, revealFrame: number): ElementLayer {
  const el = { layerId, z, revealFrame };
  switch (l.type) {
    case 'plate':
      return { type: 'plate', ...el, box: FULL_FRAME, key: l.key };
    case 'video':
      return { type: 'broll', ...el, box: FULL_FRAME, key: l.key, trimStartFrame: l.trimStartFrame };
    case 'cutout':
      return { type: 'product', ...el, box: productBox(l), key: l.key, shadow: l.shadow };
    case 'text':
      return { type: 'headline', ...el, box: TEXT_BOX[l.position], content: l.content, style: { weight: l.weight, scrim: l.scrim } };
  }
}

/** A stored v1 spec → v2. Ids are `s<i>.<kind>`; a repeated kind in one scene gets `.1`, `.2`, … */
export function upgradeSpec(v1: VideoSpecV1): VideoSpec {
  return VideoSpec.parse({
    version: 2,
    id: v1.id,
    width: v1.width,
    height: v1.height,
    fps: v1.fps,
    durationInFrames: v1.durationInFrames,
    theme: v1.theme,
    scenes: v1.scenes.map((s, i) => {
      const seen = new Map<string, number>();
      return {
        startFrame: s.startFrame,
        durationInFrames: s.durationInFrames,
        motion: s.motion,
        transitionIn: 'cut',
        layers: s.layers.map((l, z) => {
          const id = `s${i}.${KIND[l.type]}`;
          const n = seen.get(id) ?? 0;
          seen.set(id, n + 1);
          return upgradeLayer(l, n ? `${id}.${n}` : id, z, s.startFrame);
        }),
      };
    }),
    audio: { voice: v1.audio.voice, music: [], sfx: [] },
    captions: { position: v1.captions.position, style: { weight: 'bold' }, words: v1.captions.words },
  });
}

/** A `variants.spec` row (or any persisted spec) → v2: v2 parses as-is, anything else must be a valid v1. */
export function readSpec(raw: unknown): VideoSpec {
  const version = (raw as { version?: unknown } | null)?.version;
  return version === 2 ? VideoSpec.parse(raw) : upgradeSpec(VideoSpecV1.parse(raw));
}
