import { describe, expect, it } from 'vitest';
import type { EditOp } from '../src/project';
import { RecipeGraph, canonicalJson, recipeKey, type Recipe } from '../src/recipe';
import { compileVariant } from './compile-fixture';

const ORG_A = '00000000-0000-4000-8000-00000000000a';
const ORG_B = '00000000-0000-4000-8000-00000000000b';
const tts = (orgId = ORG_A, request: Recipe['request'] = { text: 'Pure oil.', language: 'en', emotion: 0.5 }): Recipe => ({
  kind: 'tts', provider: 'qwen-tts', model: 'qwen', version: 'v'.repeat(64), request, orgId,
});

describe('canonicalJson', () => {
  it('sorts keys at every depth, keeps array order, has no whitespace, drops undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: 'x' }, u: undefined })).toBe('{"a":{"c":"x","d":[3,{"x":2,"y":1}]},"b":1}');
  });
});

describe('recipeKey', () => {
  it('identical recipes give identical keys (sha256 hex)', () => {
    expect(recipeKey(tts())).toBe(recipeKey(tts()));
    expect(recipeKey(tts())).toMatch(/^[0-9a-f]{64}$/);
  });
  it('the same request in a different org gives a different key (Review Focus 1)', () => {
    expect(recipeKey(tts(ORG_B))).not.toBe(recipeKey(tts(ORG_A)));
  });
  it('key order in request does not change the key', () => {
    expect(recipeKey(tts(ORG_A, { emotion: 0.5, language: 'en', text: 'Pure oil.' }))).toBe(recipeKey(tts()));
  });
  it('any request change, a seed, or a version change gives a new key', () => {
    const base = recipeKey(tts());
    expect(recipeKey(tts(ORG_A, { text: 'Pure oil!', language: 'en', emotion: 0.5 }))).not.toBe(base);
    expect(recipeKey({ ...tts(), seed: 7 })).not.toBe(base);
    expect(recipeKey({ ...tts(), version: 'w'.repeat(64) })).not.toBe(base);
  });
});

describe('RecipeGraph', () => {
  const v = compileVariant(); // beat 0 is the first product-absent beat: the b-roll beat
  const g = RecipeGraph.fromVariant(v);

  it('dependents are transitive downstream tags', () => {
    expect(g.dependents('voice:1')).toEqual(['align:1']);
    expect(g.dependents('cutout')).toEqual([]);
    expect(g.dependents('plate:0')).toEqual(['broll']);
    expect(g.dependents('plate:2')).toEqual([]);
    expect(g.dependents('align:1')).toEqual([]);
  });

  it('free ops invalidate nothing', () => {
    const free: EditOp[] = [
      { op: 'move', layerId: 's0.headline', x: 1, y: 2 },
      { op: 'resize', layerId: 's0.product', w: 10, h: 10 },
      { op: 'setText', layerId: 's0.headline', content: 'Hi' },
      { op: 'setStyle', layerId: 'captions', style: { position: 'top_third' } },
      { op: 'retime', layerId: 's0.headline', reveal: { kind: 'scene', offsetFrames: 3 } },
      { op: 'lock' },
      { op: 'unlock' },
    ];
    expect(g.invalidated(free)).toEqual([]);
  });

  it('a VO or emotion edit invalidates exactly that line: its TTS and alignment', () => {
    expect(g.invalidated([{ op: 'setField', beat: 1, path: 'vo', value: 'New line.' }])).toEqual(['align:1', 'voice:1']);
    expect(g.invalidated([{ op: 'setField', beat: 1, path: 'emotion', value: '0.9' }])).toEqual(['align:1', 'voice:1']);
    expect(g.invalidated([{ op: 'regenerate', assetTag: 'voice:2' }])).toEqual(['align:2', 'voice:2']);
  });

  it('a scene edit or plate regenerate invalidates the plate plus b-roll when it is the b-roll beat', () => {
    expect(g.invalidated([{ op: 'setField', beat: 0, path: 'scene', value: 'a sunlit kitchen counter' }])).toEqual(['broll', 'plate:0']);
    expect(g.invalidated([{ op: 'setField', beat: 2, path: 'scene', value: 'a sunlit kitchen counter' }])).toEqual(['plate:2']);
    expect(g.invalidated([{ op: 'regenerate', assetTag: 'plate:0' }])).toEqual(['broll', 'plate:0']);
  });

  it('ops on different beats give the sorted union, without duplicates', () => {
    expect(g.invalidated([
      { op: 'setField', beat: 2, path: 'vo', value: 'x' },
      { op: 'move', layerId: 's1.headline', x: 0, y: 0 },
      { op: 'setField', beat: 0, path: 'scene', value: 'a sunlit kitchen counter' },
      { op: 'regenerate', assetTag: 'voice:2' },
    ])).toEqual(['align:2', 'broll', 'plate:0', 'voice:2']);
  });

  it('an op on a beat the variant does not have invalidates nothing (it is dropped at compile)', () => {
    expect(g.invalidated([{ op: 'setField', beat: 9, path: 'vo', value: 'x' }, { op: 'regenerate', assetTag: 'plate:9' }])).toEqual([]);
  });

  it('a structural edit throws: its executor arrives with Director v2', () => {
    expect(() => g.invalidated([{ op: 'setField', beat: 0, path: 'format', value: 'x' }])).toThrow(/Director v2/);
  });

  it('a variant with no product-absent beat has no b-roll dependent', () => {
    const w = compileVariant();
    for (const s of w.scenes) s.product_prominence = 'hero';
    expect(RecipeGraph.fromVariant(w).dependents('plate:0')).toEqual([]);
  });
});
