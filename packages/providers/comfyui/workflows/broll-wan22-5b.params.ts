import type { BrollParams, Manifest } from '../src/workflows';

export const brollWan22_5b: Manifest<BrollParams> = {
  name: 'broll-wan22-5b',
  output: { title: 'out:video', mime: 'video/mp4' },
  size: { width: 704, height: 1280 },
  fps: 24,
  sample: {
    prompt: 'slow drifting warm sunlight, soft dust in the air, subtle ambient motion, static camera',
    seed: 7,
    image: 'plate.png',
    width: 704,
    height: 1280,
    length: 121,
  },
  toPatches: (p) => ({
    'in:prompt': { text: p.prompt },
    'in:seed': { seed: p.seed },
    'in:image': { image: p.image },
    'in:size': { width: p.width, height: p.height, length: p.length },
  }),
};
