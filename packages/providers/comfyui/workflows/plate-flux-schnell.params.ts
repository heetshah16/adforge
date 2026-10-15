import type { Manifest, PlateParams } from '../src/workflows';

export const plateFluxSchnell: Manifest<PlateParams> = {
  name: 'plate-flux-schnell',
  output: { title: 'out:image', mime: 'image/png' },
  sample: {
    prompt: 'warm natural daylight, real lived-in kitchen interior, empty surface in the foreground',
    seed: 1,
    width: 768,
    height: 1344,
  },
  toPatches: (p) => ({
    'in:prompt': { text: p.prompt },
    'in:seed': { seed: p.seed },
    'in:size': { width: p.width, height: p.height },
  }),
};
