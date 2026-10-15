import type { CutoutParams, Manifest } from '../src/workflows';

export const cutoutBirefnet: Manifest<CutoutParams> = {
  name: 'cutout-birefnet',
  output: { title: 'out:image', mime: 'image/png' },
  sample: { image: 'product.png' },
  toPatches: (p) => ({ 'in:image': { image: p.image } }),
};
