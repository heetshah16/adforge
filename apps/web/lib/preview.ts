import type { VideoSpec } from '@adforge/core/spec/video-spec';
import { composeHtml, secs } from '@adforge/renderer-hyperframes/compose';

/** apps/web/public/hf/ (populated by scripts/copy-hf-assets.ts, gitignored): gsap, fonts, and the HyperFrames runtime. */
export const PREVIEW_STATIC_BASE = '/hf';
export const PREVIEW_RUNTIME_SRC = `${PREVIEW_STATIC_BASE}/hyperframe.runtime.iife.js`;

/** The same composition the renderer stages, with assets loaded straight from storage URLs and gsap/fonts from /hf. */
export const previewHtml = (spec: VideoSpec, mediaUrl: (key: string) => string): string =>
  composeHtml(spec, { assetUrl: mediaUrl, staticBase: PREVIEW_STATIC_BASE });

/** The player seeks in seconds; this is the compositor's own frame to seconds conversion, so frame n lands on frame n. */
export const previewFrame = (frame: number, fps: number): number => Number(secs(frame, fps));
