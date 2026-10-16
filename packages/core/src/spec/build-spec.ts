import { PIPELINE, type PipelineConfig } from '../config/pipeline';
import { TREATMENTS } from '../config/treatments';
import type { DirectorVariant } from '../llm/schemas';
import type { AlignedWord } from '../providers/types';
import { secondsToFrames } from './frames';
import { VideoSpec, type Layer, type Scene } from './video-spec';

export interface BeatAssets {
  plate: string;
  cutout?: string;
  broll?: { key: string; durationSec: number };
  voice: { key: string; durationSec: number };
  words: AlignedWord[];
}
export interface BuildSpecInput {
  id: string;
  variant: DirectorVariant;
  beats: BeatAssets[];
  theme?: { primary: string; accent: string };
  cfg?: PipelineConfig;
}

/** Director variant + generated assets → our IR. Seconds become frames here and nowhere else in the pipeline. */
export function buildSpec(input: BuildSpecInput): VideoSpec {
  const cfg = input.cfg ?? PIPELINE;
  const { fps } = cfg.video;
  const v = input.variant;
  if (input.beats.length !== v.scenes.length) throw new Error(`buildSpec: ${v.scenes.length} scenes but ${input.beats.length} beat assets`);
  const t = TREATMENTS[v.visual_treatment];
  const overlayPosition = t.captionPosition === 'top_third' ? 'mid_lower' : 'top_third';

  const scenes: Scene[] = [];
  const voice: VideoSpec['audio']['voice'] = [];
  const words: VideoSpec['captions']['words'] = [];
  let cursor = 0;

  v.scenes.forEach((scene, i) => {
    const a = input.beats[i]!;
    const voiceFrames = Math.max(1, secondsToFrames(a.voice.durationSec, fps));
    const frames = Math.max(secondsToFrames(scene.duration, fps), voiceFrames + cfg.timing.voTailFrames);
    const layers: Layer[] = [];

    const brollFits = a.broll && secondsToFrames(a.broll.durationSec, fps) >= frames;
    if (scene.product_prominence === 'absent' && brollFits) {
      layers.push({ type: 'video', key: a.broll!.key, trimStartFrame: 0 });
    } else {
      layers.push({ type: 'plate', key: a.plate });
    }
    if (scene.product_prominence !== 'absent') {
      if (!a.cutout) throw new Error(`buildSpec: scene ${i + 1} is ${scene.product_prominence} but has no cutout key`);
      layers.push({ type: 'cutout', key: a.cutout, ...cfg.composite[scene.product_prominence], shadow: true });
    }
    layers.push({ type: 'text', content: scene.overlay, position: overlayPosition, weight: t.captionWeight, scrim: t.scrim });

    // VideoSpec requires video-background scenes to be static (P3 final review, ADR 0008).
    scenes.push({ startFrame: cursor, durationInFrames: frames, motion: layers[0]!.type === 'video' ? 'static' : scene.motion, layers });
    voice.push({ key: a.voice.key, startFrame: cursor, durationInFrames: voiceFrames });

    for (const w of a.words) {
      if (w.endSec <= w.startSec) continue; // zero-length tail words from alignScript carry no speech
      const prevEnd = words.at(-1)?.endFrame ?? 0;
      const start = Math.max(prevEnd, cursor + secondsToFrames(w.startSec, fps));
      const end = Math.min(cursor + frames, Math.max(start + 1, cursor + secondsToFrames(w.endSec, fps)));
      if (start >= cursor + frames || end <= start) continue;
      words.push({ text: w.text, startFrame: start, endFrame: end });
    }
    cursor += frames;
  });

  return VideoSpec.parse({
    id: input.id,
    width: cfg.video.width,
    height: cfg.video.height,
    fps,
    durationInFrames: cursor,
    theme: input.theme ?? { primary: '#141414', accent: '#f5b301' },
    scenes,
    audio: { voice },
    captions: { position: t.captionPosition, words },
  });
}
