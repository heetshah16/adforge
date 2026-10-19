import type { VideoSpecV1 } from '@adforge/core/spec/video-spec';

export const N = 5;
export type IdentityKeys = { plate: string; cutout: string; broll: string; voice: string };

/** The two v1 specs the v2 compositor must render pixel-identically (v2-identity.test.ts). */
export function identitySpecs(k: IdentityKeys): Record<'plate-cutout-text' | 'broll', VideoSpecV1> {
  const base = { width: 240, height: 426, fps: 30 as const, durationInFrames: N, theme: { primary: '#141414', accent: '#f5b301' } };
  const audio = { voice: [{ key: k.voice, startFrame: 0, durationInFrames: N }] };
  return {
    'plate-cutout-text': {
      ...base,
      id: 'plate-cutout-text',
      scenes: [{
        startFrame: 0, durationInFrames: N, motion: 'slow_zoom_in',
        layers: [
          { type: 'plate', key: k.plate },
          // anchorX < 0.5 so the upgraded product box has x < 0 (the product-only exemption).
          { type: 'cutout', key: k.cutout, anchorX: 0.4, anchorY: 0.86, heightFrac: 0.42, shadow: true },
          { type: 'text', content: 'हिंदी ok', position: 'top_third', weight: 'bold', scrim: true },
        ],
      }],
      audio,
      captions: { position: 'bottom_center', words: [{ text: 'असली', startFrame: 1, endFrame: 4 }] },
    },
    broll: {
      ...base,
      id: 'broll',
      scenes: [{
        startFrame: 0, durationInFrames: N, motion: 'static',
        layers: [
          { type: 'video', key: k.broll, trimStartFrame: 3 },
          { type: 'text', content: 'Cold pressed', position: 'mid_lower', weight: 'chunky', scrim: false },
        ],
      }],
      audio,
      captions: { position: 'top_third', words: [{ text: 'Stop', startFrame: 0, endFrame: 2 }, { text: 'now', startFrame: 2, endFrame: 5 }] },
    },
  };
}
