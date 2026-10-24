import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { classifyEdit, compileProject, EditOp, type DroppedOp, type Project, type ProjectBase } from '../src/project/index';
import { buildSpec } from '../src/spec/build-spec';
import { upgradeSpec } from '../src/spec/upgrade-spec';
import { VideoSpec, VideoSpecV1 } from '../src/spec/video-spec';
import { beat, compileBeats, compileVariant } from './compile-fixture';

const base = (): ProjectBase => ({ id: 'v1', variant: compileVariant(), theme: { primary: '#141414', accent: '#f5b301' } });
const compile = (...ops: EditOp[]) => compileProject({ base: base(), ops } satisfies Project, compileBeats());
const drop = (op: EditOp, reason: DroppedOp['reason']): DroppedOp => ({ op, reason });
const golden = (name: string, spec: VideoSpec) => expect(JSON.stringify(spec, null, 2) + '\n').toMatchFileSnapshot(`./golden/${name}.json`);
const layer = (spec: VideoSpec, id: string) => spec.scenes.flatMap((s) => s.layers).find((l) => l.layerId === id)!;
const sceneWords = (spec: VideoSpec, i: number) => {
  const s = spec.scenes[i]!;
  return spec.captions.words.filter((w) => w.startFrame >= s.startFrame && w.startFrame < s.startFrame + s.durationInFrames);
};

describe('compileProject: beats out of range', () => {
  it('setField / regenerate on a beat the variant lacks drop as invalid; in-range ones do not', () => {
    const n = compileVariant().scenes.length;
    const ops: EditOp[] = [
      { op: 'setField', beat: n, path: 'vo', value: 'x' },
      { op: 'regenerate', assetTag: `plate:${n}` },
      { op: 'setField', beat: n - 1, path: 'vo', value: 'x' },
      { op: 'regenerate', assetTag: 'voice:0' },
    ];
    expect(compile(...ops).dropped).toEqual([drop(ops[0]!, 'invalid'), drop(ops[1]!, 'invalid')]);
  });
});

describe('compileProject: base', () => {
  it('with no ops reproduces the pre-C2 buildSpec, upgraded', () => {
    const old = VideoSpecV1.parse(JSON.parse(readFileSync(new URL('./golden/compile-base.json', import.meta.url), 'utf8')));
    const { spec, dropped } = compile();
    expect(spec).toEqual(upgradeSpec(old));
    expect(dropped).toEqual([]);
  });

  it('buildSpec is compileProject with no ops', () => {
    expect(buildSpec({ id: 'v1', variant: compileVariant(), beats: compileBeats() })).toEqual(compile().spec);
  });

  it('is pure: same input, same output, inputs untouched', () => {
    const project: Project = { base: base(), ops: [{ op: 'move', layerId: 's2.headline', x: 0.1, y: 0.3 }] };
    const beats = compileBeats();
    const before = structuredClone({ project, beats });
    const a = compileProject(project, beats);
    expect(compileProject(project, beats)).toEqual(a);
    expect({ project, beats }).toEqual(before);
  });
});

describe('compileProject: one golden per op kind', () => {
  it('move', async () => {
    const { spec, dropped } = compile({ op: 'move', layerId: 's2.headline', x: 0.1, y: 0.3 });
    expect(dropped).toEqual([]);
    expect(layer(spec, 's2.headline').box).toEqual({ x: 0.1, y: 0.3, w: 0.88, h: 0.2 });
    await golden('compile-move', spec);
  });

  it('resize', async () => {
    const { spec, dropped } = compile({ op: 'resize', layerId: 's2.product', w: 0.8, h: 0.5 });
    expect(dropped).toEqual([]);
    expect(layer(spec, 's2.product').box).toMatchObject({ w: 0.8, h: 0.5 });
    // the product renders bottom-centre anchored: a resize keeps that anchor (hero: 0.5, 0.84)
    const b = layer(spec, 's2.product').box;
    expect(b.x + b.w / 2).toBeCloseTo(0.5, 12);
    expect(b.y + b.h).toBeCloseTo(0.84, 12);
    // other boxes keep their top-left
    expect(layer(compile({ op: 'resize', layerId: 's2.headline', w: 0.5, h: 0.1 }).spec, 's2.headline').box).toEqual({ x: 0.06, y: 0.14, w: 0.5, h: 0.1 });
    await golden('compile-resize', spec);
  });

  it('setText', async () => {
    const { spec, dropped } = compile({ op: 'setText', layerId: 's3.headline', content: 'Try it tonight' });
    expect(dropped).toEqual([]);
    expect(layer(spec, 's3.headline')).toMatchObject({ content: 'Try it tonight' });
    await golden('compile-settext', spec);
  });

  it('setStyle on a headline and on the captions', async () => {
    const { spec, dropped } = compile(
      { op: 'setStyle', layerId: 's0.headline', style: { weight: 'chunky', scrim: false } },
      { op: 'setStyle', layerId: 'captions', style: { weight: 'regular', position: 'top_third' } },
    );
    expect(dropped).toEqual([]);
    expect(layer(spec, 's0.headline')).toMatchObject({ style: { weight: 'chunky', scrim: false } });
    expect(spec.captions).toMatchObject({ position: 'top_third', style: { weight: 'regular' } });
    await golden('compile-setstyle', spec);
  });

  it('retime', async () => {
    const { spec, dropped } = compile(
      { op: 'retime', layerId: 's3.headline', reveal: { kind: 'word', word: 1, offsetFrames: 2 } },
      { op: 'retime', layerId: 's2.product', reveal: { kind: 'scene', offsetFrames: 10 } },
    );
    expect(dropped).toEqual([]);
    expect(layer(spec, 's3.headline').revealFrame).toBe(sceneWords(spec, 3)[1]!.startFrame + 2);
    expect(layer(spec, 's2.product').revealFrame).toBe(spec.scenes[2]!.startFrame + 10);
    await golden('compile-retime', spec);
  });
});

describe('compileProject: ops that do not touch the layout', () => {
  it.each<EditOp>([
    { op: 'setField', beat: 1, path: 'vo', value: 'A new line' },
    { op: 'setField', beat: 1, path: 'emotion', value: '0.8' },
    { op: 'setField', beat: 2, path: 'scene', value: 'a sunlit kitchen counter' },
    { op: 'setField', beat: 0, path: 'format', value: 'ugc_testimonial' },
    { op: 'regenerate', assetTag: 'plate:2' },
    { op: 'regenerate', assetTag: 'voice:1' },
    { op: 'lock' },
    { op: 'unlock' },
  ])('$op leaves the spec unchanged', (op) => {
    expect(compile(op)).toEqual({ spec: compile().spec, dropped: [] });
  });
});

describe('compileProject: dropped ops (Review Focus 2)', () => {
  it('a move on a layer that does not exist is dropped, never thrown', () => {
    const op: EditOp = { op: 'move', layerId: 's9.headline', x: 0.1, y: 0.1 };
    expect(compile(op)).toEqual({ spec: compile().spec, dropped: [drop(op, 'missing_target')] });
  });

  it('a malformed op from raw jsonb is dropped as invalid, and compile does not throw', () => {
    const raw = { op: 'setStyle', layerId: 'captions', style: { position: 'sideways' } } as unknown as EditOp;
    expect(compile(raw)).toEqual({ spec: compile().spec, dropped: [drop(raw, 'invalid')] });
  });

  it('a move or resize on b-roll is dropped as wrong_target', () => {
    const move: EditOp = { op: 'move', layerId: 's0.broll', x: 0, y: 0 };
    const resize: EditOp = { op: 'resize', layerId: 's0.broll', w: 0.5, h: 0.5 };
    expect(compile(move, resize)).toEqual({ spec: compile().spec, dropped: [drop(move, 'wrong_target'), drop(resize, 'wrong_target')] });
  });

  it('drops an op whose target cannot take it, and keeps applying later ops', () => {
    const offFrame: EditOp = { op: 'move', layerId: 's1.headline', x: 0.5, y: 0.1 }; // 0.5 + 0.88 > 1
    const textOnPlate: EditOp = { op: 'setText', layerId: 's1.plate', content: 'nope' };
    const scrimOnCaptions: EditOp = { op: 'setStyle', layerId: 'captions', style: { scrim: true } };
    const boxOnCaptions: EditOp = { op: 'move', layerId: 'captions', x: 0, y: 0 };
    const ok: EditOp = { op: 'setText', layerId: 's1.headline', content: 'Still applied' };
    const { spec, dropped } = compile(offFrame, textOnPlate, scrimOnCaptions, boxOnCaptions, ok);
    expect(dropped).toEqual([drop(offFrame, 'invalid'), drop(textOnPlate, 'wrong_target'), drop(scrimOnCaptions, 'wrong_target'), drop(boxOnCaptions, 'wrong_target')]);
    expect(layer(spec, 's1.headline')).toMatchObject({ content: 'Still applied', box: { x: 0.06, y: 0.14 } });
  });

  it('a word cue beyond the scene\'s words falls back to scene start and is listed in dropped', () => {
    const op: EditOp = { op: 'retime', layerId: 's1.headline', reveal: { kind: 'word', word: 7, offsetFrames: 0 } };
    const { spec, dropped } = compile(op);
    expect(dropped).toEqual([drop(op, 'cue_out_of_range')]);
    expect(layer(spec, 's1.headline').revealFrame).toBe(spec.scenes[1]!.startFrame);
  });

  it('a cue resolving past the scene end falls back to scene start and is listed in dropped', () => {
    const op: EditOp = { op: 'retime', layerId: 's1.headline', reveal: { kind: 'scene', offsetFrames: 9999 } };
    const { spec, dropped } = compile(op);
    expect(dropped).toEqual([drop(op, 'cue_out_of_range')]);
    expect(layer(spec, 's1.headline').revealFrame).toBe(spec.scenes[1]!.startFrame);
  });
});

describe('compileProject: a VO edit that lengthens a line (Review Focus 3)', () => {
  const ops: EditOp[] = [
    { op: 'retime', layerId: 's1.headline', reveal: { kind: 'word', word: 2, offsetFrames: 3 } },
    { op: 'retime', layerId: 's2.headline', reveal: { kind: 'scene', offsetFrames: 12 } },
  ];
  const before = compileProject({ base: base(), ops }, compileBeats());
  const longer = compileBeats();
  // beat 1's voice goes from 2.0 s to 3.5 s, its words stretched with it
  longer[1] = beat(2, 3.5, { words: longer[1]!.words.map((w) => ({ ...w, startSec: w.startSec * 1.75, endSec: w.endSec * 1.75 })) });
  const after = compileProject({ base: base(), ops }, longer);

  it('grows scene 1 by 45 frames and shifts every later scene, voice track and caption by 45', () => {
    expect(before.dropped).toEqual([]);
    expect(after.dropped).toEqual([]);
    expect(after.spec.scenes[1]!.durationInFrames - before.spec.scenes[1]!.durationInFrames).toBe(45);
    expect(after.spec.durationInFrames - before.spec.durationInFrames).toBe(45);
    for (const i of [2, 3]) {
      expect(after.spec.scenes[i]!.startFrame).toBe(before.spec.scenes[i]!.startFrame + 45);
      expect(after.spec.audio.voice[i]!.startFrame).toBe(before.spec.audio.voice[i]!.startFrame + 45);
      expect(sceneWords(after.spec, i).map((w) => w.startFrame)).toEqual(sceneWords(before.spec, i).map((w) => w.startFrame + 45));
    }
  });

  it('a word-cued reveal follows its word in both compiles', () => {
    for (const { spec } of [before, after]) {
      expect(layer(spec, 's1.headline').revealFrame).toBe(sceneWords(spec, 1)[2]!.startFrame + 3);
    }
    expect(layer(after.spec, 's1.headline').revealFrame).toBeGreaterThan(layer(before.spec, 's1.headline').revealFrame);
  });

  it('a scene-cued reveal keeps scene start + offset', () => {
    for (const { spec } of [before, after]) expect(layer(spec, 's2.headline').revealFrame).toBe(spec.scenes[2]!.startFrame + 12);
  });

  it('parses, with no overlapping words', () => {
    expect(VideoSpec.safeParse(after.spec).success).toBe(true);
    const w = after.spec.captions.words;
    for (let i = 1; i < w.length; i++) expect(w[i]!.startFrame).toBeGreaterThanOrEqual(w[i - 1]!.endFrame);
  });
});

describe('classifyEdit', () => {
  it.each<[EditOp, ReturnType<typeof classifyEdit>]>([
    [{ op: 'move', layerId: 's0.headline', x: 0, y: 0 }, 'free'],
    [{ op: 'resize', layerId: 's0.headline', w: 0.5, h: 0.2 }, 'free'],
    [{ op: 'setText', layerId: 's0.headline', content: 'x' }, 'free'],
    [{ op: 'setStyle', layerId: 'captions', style: { position: 'mid_lower' } }, 'free'],
    [{ op: 'retime', layerId: 's0.headline', reveal: { kind: 'scene', offsetFrames: 0 } }, 'free'],
    [{ op: 'lock' }, 'free'],
    [{ op: 'unlock' }, 'free'],
    [{ op: 'setField', beat: 0, path: 'vo', value: 'x' }, 'voice'],
    [{ op: 'setField', beat: 0, path: 'emotion', value: '0.5' }, 'voice'],
    [{ op: 'regenerate', assetTag: 'voice:0' }, 'voice'],
    [{ op: 'setField', beat: 0, path: 'scene', value: 'x' }, 'shot'],
    [{ op: 'regenerate', assetTag: 'plate:0' }, 'shot'],
    [{ op: 'setField', beat: 0, path: 'format', value: 'x' }, 'structural'],
  ])('%j is %s', (op, kind) => {
    expect(classifyEdit(EditOp.parse(op))).toBe(kind);
  });
});

describe('EditOp schema', () => {
  it('allows position only on the captions target', () => {
    expect(EditOp.safeParse({ op: 'setStyle', layerId: 's0.headline', style: { position: 'top_third' } }).success).toBe(false);
    expect(EditOp.safeParse({ op: 'setStyle', layerId: 'captions', style: { position: 'top_third' } }).success).toBe(true);
  });

  it('rejects malformed ops', () => {
    expect(EditOp.safeParse({ op: 'regenerate', assetTag: 'broll:1' }).success).toBe(false);
    expect(EditOp.safeParse({ op: 'setText', layerId: 's0.headline', content: 'x'.repeat(61) }).success).toBe(false);
    expect(EditOp.safeParse({ op: 'move', layerId: 'S0 HEADLINE', x: 0, y: 0 }).success).toBe(false);
    expect(EditOp.safeParse({ op: 'retime', layerId: 's0.headline', reveal: { kind: 'word', word: -1, offsetFrames: 0 } }).success).toBe(false);
  });
});
