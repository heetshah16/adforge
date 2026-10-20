import type { Box, Scene, VideoSpec } from '@adforge/core/spec/video-spec';
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

/** 'ab/<sha>.png' or 'org/<id>/ab/<sha>.png' → 'assets/<sha>.png' (content-addressed, so flat is unique; stage.ts copies each key there). */
export const assetPath = (key: string): string => `assets/${key.slice(key.lastIndexOf('/') + 1)}`;

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

const fontFaces = (base: string) =>
  FONT_FILES.map((f) => `@font-face { font-family: '${f.family}'; font-weight: ${f.weight}; src: url('${base}/fonts/${f.file}') format('woff2'); }`).join('\n');

function css(spec: VideoSpec, staticBase: string): string {
  return `${fontFaces(staticBase)}
body { margin: 0; background: ${spec.theme.primary}; }
#root { position: relative; width: 100%; height: 100%; overflow: hidden; background: ${spec.theme.primary};
  font-family: 'Inter', 'Noto Sans Devanagari', sans-serif; }
.clip { position: absolute; inset: 0; }
video.clip { object-fit: cover; }
.stage { position: absolute; inset: 0; transform-origin: 50% 60%; }
.plate { position: absolute; object-fit: cover; }
.product { position: absolute; translate: -50% -100%; width: auto; }
.product.shadow { filter: drop-shadow(0 18px 24px rgba(0, 0, 0, 0.45)); }
.logo { position: absolute; object-fit: contain; }
.overlay { position: absolute; box-sizing: border-box; text-align: center; color: #fff; line-height: 1.1; overflow-wrap: anywhere; text-shadow: 0 2px 8px rgba(0,0,0,.6); }
.overlay.scrim { background: rgba(0, 0, 0, 0.45); padding: 0.4em 0.6em; border-radius: 0.3em; }
.w-regular { font-weight: 600; font-size: 64px; }
.w-bold { font-weight: 800; font-size: 72px; }
.w-chunky { font-weight: 900; font-size: 84px; }
.cap { display: flex; justify-content: center; align-items: flex-start; }
.cap > span { margin-top: 0; font-weight: 800; font-size: 76px; color: #fff; background: #000; padding: 0.1em 0.35em; border-radius: 0.2em; max-width: 92%; overflow-wrap: anywhere; }
.cap.cw-regular > span { font-weight: 600; font-size: 68px; }
.cap.cw-chunky > span { font-weight: 900; font-size: 84px; }
.cap.pos-top_third { top: 14%; }
.cap.pos-top_third > span { margin-top: 14%; }
.cap.pos-mid_lower { top: 58%; }
.cap.pos-bottom_center { top: 80%; }`;
}

const pct = (n: number) => `${(n * 100).toFixed(3)}%`;
const boxCss = (b: Box) => `left: ${pct(b.x)}; top: ${pct(b.y)}; width: ${pct(b.w)}; height: ${pct(b.h)};`;

/**
 * One scene's elements in z order, each timed from its own revealFrame to the scene end. Plates and
 * the product share the scene's motion: each run of them in z order sits in a `.stage` the motion
 * tween drives. Broll is emitted at the root by composeHtml (a timed <video> may not sit in a timed wrapper).
 */
function sceneElements(scene: Scene, fps: number, url: (key: string) => string): string {
  const end = scene.startFrame + scene.durationInFrames;
  const out: string[] = [];
  let stage: string[] | undefined;
  const flush = () => {
    if (stage) out.push(`<div class="stage">${stage.join('')}</div>`);
    stage = undefined;
  };
  for (const l of [...scene.layers].sort((a, b) => a.z - b.z)) {
    const t = span(l.revealFrame, end - l.revealFrame, fps);
    const attrs = `data-layer-id="${esc(l.layerId)}" data-start="${t.start}" data-duration="${t.duration}"`;
    switch (l.type) {
      case 'broll':
        break;
      case 'plate':
        (stage ??= []).push(`<img class="plate" src="${esc(url(l.key))}" alt="" ${attrs} style="${boxCss(l.box)}">`);
        break;
      case 'product': {
        // Bottom-centre anchored, height h, natural width: the v1 cutout CSS exactly.
        const b = l.box;
        (stage ??= []).push(
          `<img class="product${l.shadow ? ' shadow' : ''}" src="${esc(url(l.key))}" alt="" ${attrs} ` +
            `style="left: ${pct(b.x + b.w / 2)}; top: ${pct(b.y + b.h)}; height: ${pct(b.h)};">`,
        );
        break;
      }
      case 'logo':
        flush();
        out.push(`<img class="logo" src="${esc(url(l.key))}" alt="" ${attrs} style="${boxCss(l.box)}">`);
        break;
      default:
        // Text: positioned and sized in width by its box; its height is the content's (h is the edit slot), as in v1.
        // ponytail: every text element type renders as the overlay; per-type looks (chip, cta_button…) land with C4 visuals.
        flush();
        out.push(
          `<div class="overlay el-${l.type} w-${l.style.weight}${l.style.scrim ? ' scrim' : ''}" ${attrs} ` +
            `style="left: ${pct(l.box.x)}; top: ${pct(l.box.y)}; width: ${pct(l.box.w)};">${esc(l.content)}</div>`,
        );
    }
  }
  flush();
  return out.join('');
}

export interface ComposeOptions {
  /** Storage key → the src the composition loads. Default: the staged project path (assetPath). The preview passes a media URL. */
  assetUrl?: (key: string) => string;
  /** Where gsap.min.js and fonts/ live, relative to the composition (staged project) or absolute (the preview serves them from /hf). */
  staticBase?: string;
}

/** Every storage key a spec references (layers and audio tracks). Browser-safe: stage.ts and the preview both use it. */
export function specKeys(spec: VideoSpec): string[] {
  const keys = new Set<string>();
  for (const scene of spec.scenes) for (const l of scene.layers) if ('key' in l) keys.add(l.key);
  for (const a of [...spec.audio.voice, ...spec.audio.music, ...spec.audio.sfx]) keys.add(a.key);
  return [...keys];
}

const dbVolume = (gainDb: number) => (10 ** (gainDb / 20)).toFixed(4);

export function composeHtml(spec: VideoSpec, opts: ComposeOptions = {}): string {
  const { fps } = spec;
  const url = opts.assetUrl ?? assetPath;
  const staticBase = opts.staticBase ?? 'assets';
  const body: string[] = [];
  const tweens: string[] = [];

  spec.scenes.forEach((scene, i) => {
    const end = scene.startFrame + scene.durationInFrames;
    const t = span(scene.startFrame, scene.durationInFrames, fps);
    const broll = scene.layers.find((l) => l.type === 'broll');
    if (broll) {
      const b = span(broll.revealFrame, end - broll.revealFrame, fps);
      body.push(
        `<video id="s${i}-video" class="clip" src="${esc(url(broll.key))}" muted playsinline data-layer-id="${esc(broll.layerId)}" data-start="${b.start}" data-duration="${b.duration}" data-media-start="${secs(broll.trimStartFrame, fps)}" style="${boxCss(broll.box)}"></video>`,
      );
    }
    body.push(`<section id="s${i}" class="clip" data-start="${t.start}" data-duration="${t.duration}">${sceneElements(scene, fps, url)}</section>`);
    if (scene.layers.some((l) => l.type === 'plate' || l.type === 'product')) {
      tweens.push(motionTween(`#s${i} > .stage`, scene.motion, t.start, t.duration));
    }
  });

  spec.audio.voice.forEach((v, i) => {
    const t = span(v.startFrame, v.durationInFrames, fps);
    body.push(`<audio id="vo${i}" src="${esc(url(v.key))}" data-start="${t.start}" data-duration="${t.duration}" data-volume="1"></audio>`);
  });
  for (const kind of ['music', 'sfx'] as const) {
    spec.audio[kind].forEach((a, i) => {
      const t = span(a.startFrame, a.durationInFrames, fps);
      body.push(`<audio id="${kind}${i}" src="${esc(url(a.key))}" data-start="${t.start}" data-duration="${t.duration}" data-volume="${dbVolume(a.gainDb)}"></audio>`);
    });
  }

  spec.captions.words.forEach((w, i) => {
    const t = span(w.startFrame, w.endFrame - w.startFrame, fps);
    body.push(
      `<div id="w${i}" class="clip cap pos-${spec.captions.position} cw-${spec.captions.style.weight}" data-start="${t.start}" data-duration="${t.duration}"><span>${esc(w.text)}</span></div>`,
    );
  });

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=${spec.width}, height=${spec.height}">
<title>${esc(spec.id)}</title>
<script src="${staticBase}/gsap.min.js"></script>
<style>
${css(spec, staticBase)}
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
