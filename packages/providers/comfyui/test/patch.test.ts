import { describe, expect, it } from 'vitest';
import { nodeIdByTitle, patchWorkflow, type ApiWorkflow } from '../src/patch';
import {
  BROLL_WORKFLOWS,
  BrollParams,
  CUTOUT_WORKFLOWS,
  PLATE_WORKFLOWS,
  PlateParams,
  assertManifestMatches,
  loadWorkflow,
  pickWorkflow,
} from '../src/workflows';

const wf: ApiWorkflow = {
  '1': { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['9', 1] }, _meta: { title: 'in:prompt' } },
  '2': { class_type: 'KSampler', inputs: { seed: 0, steps: 4 }, _meta: { title: 'in:seed' } },
};

describe('patchWorkflow', () => {
  it('sets inputs on the node with the given title', () => {
    const out = patchWorkflow(wf, { 'in:prompt': { text: 'hello' }, 'in:seed': { seed: 7 } });
    expect(out['1']!.inputs.text).toBe('hello');
    expect(out['2']!.inputs.seed).toBe(7);
  });
  it('never mutates the input workflow', () => {
    patchWorkflow(wf, { 'in:prompt': { text: 'hello' } });
    expect(wf['1']!.inputs.text).toBe('');
  });
  it('rejects an unknown title', () => {
    expect(() => patchWorkflow(wf, { 'in:nope': { text: 'x' } })).toThrow('exactly one node titled "in:nope", found 0');
  });
  it('rejects a duplicated title', () => {
    const dup: ApiWorkflow = { ...wf, '3': { ...wf['1']!, _meta: { title: 'in:prompt' } } };
    expect(() => nodeIdByTitle(dup, 'in:prompt')).toThrow('found 2');
  });
  it('rejects an input the node does not have (typo guard)', () => {
    expect(() => patchWorkflow(wf, { 'in:seed': { noise_seed: 1 } })).toThrow('has no input "noise_seed"');
  });
  it('refuses to overwrite a link with a value', () => {
    expect(() => patchWorkflow(wf, { 'in:prompt': { clip: 'x' } })).toThrow('is a link');
  });
});

describe('workflow manifests', () => {
  it('reject sizes the models cannot take', () => {
    expect(PlateParams.safeParse({ prompt: 'p', seed: 1, width: 770, height: 1344 }).success).toBe(false);
    expect(BrollParams.safeParse({ prompt: 'p', seed: 1, image: 'a.png', width: 704, height: 1280, length: 120 }).success).toBe(false);
    expect(BrollParams.safeParse({ prompt: 'p', seed: 1, image: 'a.png', width: 704, height: 1280, length: 121 }).success).toBe(true);
  });

  it('name unknown workflows with the known ones', () => {
    expect(() => pickWorkflow(PLATE_WORKFLOWS, 'plate-sdxl', 'plate')).toThrow(
      'Unknown plate workflow "plate-sdxl". Known: plate-flux-schnell',
    );
  });

  it('rejects path-like workflow names', () => {
    expect(() => loadWorkflow('../../package')).toThrow('Invalid workflow name');
  });

  it('detects a re-exported workflow that lost a title', () => {
    const m = pickWorkflow(PLATE_WORKFLOWS, 'plate-flux-schnell', 'plate');
    const { json } = loadWorkflow(m.name);
    const broken = structuredClone(json);
    for (const node of Object.values(broken)) if (node._meta?.title === 'in:size') node._meta.title = 'Empty Latent';
    expect(() => assertManifestMatches(broken, m)).toThrow('in:size');
  });

  type Golden = [string, () => ApiWorkflow];
  const golden: Golden[] = [
    ...Object.values(PLATE_WORKFLOWS).map((m): Golden => [m.name, () => patchWorkflow(loadWorkflow(m.name).json, m.toPatches(m.sample))]),
    ...Object.values(CUTOUT_WORKFLOWS).map((m): Golden => [m.name, () => patchWorkflow(loadWorkflow(m.name).json, m.toPatches(m.sample))]),
    ...Object.values(BROLL_WORKFLOWS).map((m): Golden => [m.name, () => patchWorkflow(loadWorkflow(m.name).json, m.toPatches(m.sample))]),
  ];
  for (const [name, patched] of golden) {
    it(`golden: ${name} patched with its sample params`, async () => {
      await expect(JSON.stringify(patched(), null, 2) + '\n').toMatchFileSnapshot(`./golden/${name}.json`);
    });
  }
});
