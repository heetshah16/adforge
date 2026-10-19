import { PIPELINE, type PipelineConfig } from '../config/pipeline';
import { TREATMENTS } from '../config/treatments';
import type { BeatAssets } from '../spec/build-spec';
import { secondsToFrames } from '../spec/frames';
import { FULL_FRAME, TEXT_BOX, productBox } from '../spec/upgrade-spec';
import { CAPTIONS_ID, ElementLayer, isText, VideoSpec, type Scene } from '../spec/video-spec';
import type { Cue, EditOp, Project, ProjectBase } from './types';

/** Word.text is max 40; a long token (e.g. a URL in vo) must not kill the job. Code-point safe. */
const clip = (s: string) => { const c = [...s]; return c.length > 40 ? c.slice(0, 39).join('') + '…' : s; };

type Words = VideoSpec['captions']['words'];

/** Director variant + generated assets → the base spec. Seconds become frames here and nowhere else in the pipeline. */
function baseSpec(base: ProjectBase, beats: BeatAssets[], cfg: PipelineConfig): { spec: VideoSpec; sceneWords: Words[] } {
  const { fps } = cfg.video;
  const v = base.variant;
  if (beats.length !== v.scenes.length) throw new Error(`compileProject: ${v.scenes.length} scenes but ${beats.length} beat assets`);
  const t = TREATMENTS[v.visual_treatment];
  const overlayPosition = t.captionPosition === 'top_third' ? 'mid_lower' : 'top_third';

  const scenes: Scene[] = [];
  const voice: VideoSpec['audio']['voice'] = [];
  const words: Words = [];
  const sceneWords: Words[] = [];
  let cursor = 0;

  v.scenes.forEach((scene, i) => {
    const a = beats[i]!;
    const voiceFrames = Math.max(1, secondsToFrames(a.voice.durationSec, fps));
    const frames = Math.max(secondsToFrames(scene.duration, fps), voiceFrames + cfg.timing.voTailFrames);
    const layers: ElementLayer[] = [];
    const el = (kind: string) => ({ layerId: `s${i}.${kind}`, z: layers.length, revealFrame: cursor });

    const brollFits = a.broll && secondsToFrames(a.broll.durationSec, fps) >= frames;
    if (scene.product_prominence === 'absent' && brollFits) {
      layers.push({ type: 'broll', ...el('broll'), box: FULL_FRAME, key: a.broll!.key, trimStartFrame: 0 });
    } else {
      layers.push({ type: 'plate', ...el('plate'), box: FULL_FRAME, key: a.plate });
    }
    if (scene.product_prominence !== 'absent') {
      if (!a.cutout) throw new Error(`compileProject: scene ${i + 1} is ${scene.product_prominence} but has no cutout key`);
      layers.push({ type: 'product', ...el('product'), box: productBox(cfg.composite[scene.product_prominence]), key: a.cutout, shadow: true });
    }
    layers.push({ type: 'headline', ...el('headline'), box: TEXT_BOX[overlayPosition], content: scene.overlay, style: { weight: t.captionWeight, scrim: t.scrim } });

    // VideoSpec requires broll scenes to be static (P3 final review, ADR 0008).
    scenes.push({ startFrame: cursor, durationInFrames: frames, motion: layers[0]!.type === 'broll' ? 'static' : scene.motion, transitionIn: 'cut', layers });
    voice.push({ key: a.voice.key, startFrame: cursor, durationInFrames: voiceFrames });

    const mine: Words = [];
    for (const w of a.words) {
      if (w.endSec <= w.startSec) continue; // zero-length tail words from alignScript carry no speech
      const prevEnd = words.at(-1)?.endFrame ?? 0;
      const start = Math.max(prevEnd, cursor + secondsToFrames(w.startSec, fps));
      const end = Math.min(cursor + frames, Math.max(start + 1, cursor + secondsToFrames(w.endSec, fps)));
      if (start >= cursor + frames || end <= start) continue;
      const word = { text: clip(w.text), startFrame: start, endFrame: end };
      words.push(word);
      mine.push(word);
    }
    sceneWords.push(mine);
    cursor += frames;
  });

  const spec: VideoSpec = {
    version: 2,
    id: base.id,
    width: cfg.video.width,
    height: cfg.video.height,
    fps,
    durationInFrames: cursor,
    theme: base.theme,
    scenes,
    audio: { voice, music: [], sfx: [] },
    captions: { position: t.captionPosition, style: { weight: 'bold' }, words },
  };
  return { spec, sceneWords };
}

type Found = { scene: number; index: number; layer: ElementLayer };
function find(spec: VideoSpec, layerId: string): Found | undefined {
  for (const [scene, s] of spec.scenes.entries()) {
    const index = s.layers.findIndex((l) => l.layerId === layerId);
    if (index >= 0) return { scene, index, layer: s.layers[index]! };
  }
}

/** Replace a layer only if the result is still a valid element (e.g. a move must keep a headline in frame). */
function replace(spec: VideoSpec, f: Found, next: unknown): boolean {
  const r = ElementLayer.safeParse(next);
  if (r.success) spec.scenes[f.scene]!.layers[f.index] = r.data;
  return r.success;
}

/** Applies one op in place; false means it could not apply (gone or wrong target) and is dropped. */
function apply(spec: VideoSpec, cues: Map<string, { cue: Cue; op: EditOp }>, op: EditOp): boolean {
  switch (op.op) {
    case 'setField':
    case 'regenerate':
    case 'lock':
    case 'unlock':
      return true; // their effect arrives through new beats from the executor, or is revision state
    case 'setStyle':
      if (op.layerId === CAPTIONS_ID) {
        if (op.style.scrim !== undefined) return false; // captions have no scrim
        if (op.style.weight) spec.captions.style.weight = op.style.weight;
        if (op.style.position) spec.captions.position = op.style.position;
        return true;
      }
      break;
  }
  const f = find(spec, op.layerId);
  if (!f) return false;
  const l = f.layer;
  switch (op.op) {
    case 'move':
      return replace(spec, f, { ...l, box: { ...l.box, x: op.x, y: op.y } });
    case 'resize':
      return replace(spec, f, { ...l, box: { ...l.box, w: op.w, h: op.h } });
    case 'setText':
      return isText(l) && replace(spec, f, { ...l, content: op.content });
    case 'setStyle':
      return isText(l) && replace(spec, f, { ...l, style: { weight: op.style.weight ?? l.style.weight, scrim: op.style.scrim ?? l.style.scrim } });
    case 'retime':
      cues.set(op.layerId, { cue: op.reveal, op });
      return true;
  }
}

/**
 * Base + ops + the current beat assets → VideoSpec v2. Pure. Ops apply in order; one that can't
 * apply (its layer is gone, or the target can't take it) is skipped and listed in `dropped`, never
 * thrown. Cues resolve last, against the final timing, so a VO edit that moves a word moves its reveal.
 */
export function compileProject(project: Project, beats: BeatAssets[], cfg: PipelineConfig = PIPELINE): { spec: VideoSpec; dropped: EditOp[] } {
  const { spec, sceneWords } = baseSpec(project.base, beats, cfg);
  const dropped: EditOp[] = [];
  const cues = new Map<string, { cue: Cue; op: EditOp }>();
  for (const op of project.ops) if (!apply(spec, cues, op)) dropped.push(op);

  spec.scenes.forEach((s, i) => {
    for (const l of s.layers) {
      const c = cues.get(l.layerId);
      if (!c) continue;
      const anchor = c.cue.kind === 'scene' ? s.startFrame : sceneWords[i]![c.cue.word]?.startFrame;
      const frame = anchor === undefined ? undefined : anchor + c.cue.offsetFrames;
      if (frame !== undefined && frame >= s.startFrame && frame < s.startFrame + s.durationInFrames) {
        l.revealFrame = frame;
      } else {
        l.revealFrame = s.startFrame; // a cue that no longer lands in its scene falls back to the scene start
        dropped.push(c.op);
      }
    }
  });
  return { spec: VideoSpec.parse(spec), dropped };
}
