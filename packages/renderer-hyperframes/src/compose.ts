import type { Layer, Scene, VideoSpec } from '@adforge/core/spec/video-spec';
import { motionTween } from './motion';

export const COMPOSITION_ID = 'adforge';

/** The ONLY frame→seconds conversion. Floors to whole µs: frame n (sampled at n/fps) always lands inside its window. */
export function secs(frame: number, fps: number): string {
  return (Math.floor((frame / fps) * 1e6) / 1e6).toFixed(6);
}
const span = (start: number, frames: number, fps: number) => ({
  start: secs(start, fps),
  duration: (Number(secs(start + frames, fps)) - Number(secs(start, fps))).toFixed(6),
});

/** 'ab/<sha>.png' → 'assets/<sha>.png' (stage.ts copies each key there). */
export const assetPath = (key: string): string => `assets/${key.slice(3)}`;

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Local font files (copied by stage.ts from these npm packages). */
export const FONT_FILES = [
  { family: 'Inter', weight: 600, pkg: '@fontsource/inter', src: 'files/inter-latin-600-normal.woff2', file: 'inter-600.woff2' },
  { family: 'Inter', weight: 800, pkg: '@fontsource/inter', src: 'files/inter-latin-800-normal.woff2', file: 'inter-800.woff2' },
  { family: 'Inter', weight: 900, pkg: '@fontsource/inter', src: 'files/inter-latin-900-normal.woff2', file: 'inter-900.woff2' },
  { family: 'Noto Sans Devanagari', weight: 600, pkg: '@fontsource/noto-sans-devanagari', src: 'files/noto-sans-devanagari-devanagari-600-normal.woff2', file: 'noto-dev-600.woff2' },
  { family: 'Noto Sans Devanagari', weight: 800, pkg: '@fontsource/noto-sans-devanagari', src: 'files/noto-sans-devanagari-devanagari-800-normal.woff2', file: 'noto-dev-800.woff2' },
] as const;

const fontFaces = FONT_FILES.map(
  (f) => `@font-face { font-family: '${f.family}'; font-weight: ${f.weight}; src: url('assets/fonts/${f.file}') format('woff2'); }`,
).join('\n');

function css(spec: VideoSpec): string {
  return `${fontFaces}
body { margin: 0; background: ${spec.theme.primary}; }
#root { position: relative; width: 100%; height: 100%; overflow: hidden; background: ${spec.theme.primary};
  font-family: 'Inter', 'Noto Sans Devanagari', sans-serif; }
.clip { position: absolute; inset: 0; }
video.clip { width: 100%; height: 100%; object-fit: cover; }
.stage { position: absolute; inset: 0; transform-origin: 50% 60%; }
.plate { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.cutout { position: absolute; translate: -50% -100%; width: auto; }
.cutout.shadow { filter: drop-shadow(0 18px 24px rgba(0, 0, 0, 0.45)); }
.overlay { position: absolute; left: 6%; right: 6%; text-align: center; color: #fff; line-height: 1.1; overflow-wrap: anywhere; text-shadow: 0 2px 8px rgba(0,0,0,.6); }
.overlay.scrim { background: rgba(0, 0, 0, 0.45); padding: 0.4em 0.6em; border-radius: 0.3em; }
.w-regular { font-weight: 600; font-size: 64px; }
.w-bold { font-weight: 800; font-size: 72px; }
.w-chunky { font-weight: 900; font-size: 84px; }
.pos-top_third { top: 14%; }
.pos-mid_lower { top: 58%; }
.pos-bottom_center { top: 74%; }
.cap { display: flex; justify-content: center; align-items: flex-start; }
.cap > span { margin-top: 0; font-weight: 800; font-size: 76px; color: #fff; background: #000; padding: 0.1em 0.35em; border-radius: 0.2em; max-width: 92%; overflow-wrap: anywhere; }
.cap.pos-top_third > span { margin-top: 14%; }
.cap.pos-mid_lower { top: 58%; }
.cap.pos-bottom_center { top: 80%; }`;
}

function sceneLayers(scene: Scene, i: number): string {
  const parts: string[] = [];
  const stage: string[] = [];
  for (const layer of scene.layers) {
    switch (layer.type) {
      case 'plate':
        stage.push(`<img class="plate" src="${assetPath(layer.key)}" alt="">`);
        break;
      case 'cutout':
        stage.push(
          `<img class="cutout${layer.shadow ? ' shadow' : ''}" src="${assetPath(layer.key)}" alt="" ` +
            `style="left: ${(layer.anchorX * 100).toFixed(3)}%; top: ${(layer.anchorY * 100).toFixed(3)}%; height: ${(layer.heightFrac * 100).toFixed(3)}%;">`,
        );
        break;
      case 'text':
        parts.push(
          `<div class="overlay pos-${layer.position} w-${layer.weight}${layer.scrim ? ' scrim' : ''}">${esc(layer.content)}</div>`,
        );
        break;
      case 'video':
        break; // emitted at the root (a <video data-start> may not sit inside a timed wrapper)
    }
  }
  const stageHtml = stage.length ? `<div id="s${i}-stage" class="stage">${stage.join('')}</div>` : '';
  return stageHtml + parts.join('');
}

const videoOf = (scene: Scene) => scene.layers.find((l): l is Extract<Layer, { type: 'video' }> => l.type === 'video');

export function composeHtml(spec: VideoSpec): string {
  const { fps } = spec;
  const body: string[] = [];
  const tweens: string[] = [];

  spec.scenes.forEach((scene, i) => {
    const t = span(scene.startFrame, scene.durationInFrames, fps);
    const video = videoOf(scene);
    if (video) {
      body.push(
        `<video id="s${i}-video" class="clip" src="${assetPath(video.key)}" muted playsinline data-start="${t.start}" data-duration="${t.duration}" data-media-start="${secs(video.trimStartFrame, fps)}"></video>`,
      );
    }
    body.push(`<section id="s${i}" class="clip" data-start="${t.start}" data-duration="${t.duration}">${sceneLayers(scene, i)}</section>`);
    if (scene.layers.some((l) => l.type === 'plate' || l.type === 'cutout')) {
      tweens.push(motionTween(`#s${i}-stage`, scene.motion, t.start, t.duration));
    }
  });

  spec.audio.voice.forEach((v, i) => {
    const t = span(v.startFrame, v.durationInFrames, fps);
    body.push(`<audio id="vo${i}" src="${assetPath(v.key)}" data-start="${t.start}" data-duration="${t.duration}" data-volume="1"></audio>`);
  });

  spec.captions.words.forEach((w, i) => {
    const t = span(w.startFrame, w.endFrame - w.startFrame, fps);
    body.push(
      `<div id="w${i}" class="clip cap pos-${spec.captions.position}" data-start="${t.start}" data-duration="${t.duration}"><span>${esc(w.text)}</span></div>`,
    );
  });

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=${spec.width}, height=${spec.height}">
<title>${esc(spec.id)}</title>
<script src="assets/gsap.min.js"></script>
<style>
${css(spec)}
</style>
</head>
<body>
<div id="root" data-composition-id="${COMPOSITION_ID}" data-start="0" data-width="${spec.width}" data-height="${spec.height}" data-duration="${secs(spec.durationInFrames, fps)}">
${body.join('\n')}
</div>
<script>
const tl = gsap.timeline({ paused: true });
${tweens.join('')}window.__timelines["${COMPOSITION_ID}"] = tl;
</script>
</body>
</html>
`;
}
