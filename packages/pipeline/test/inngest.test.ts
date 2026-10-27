import { describe, expect, it } from 'vitest';
import { HEAVY_CONCURRENCY, createFunctions, inngest, makeInngest } from '../src/inngest';
import { makeDeps } from './fakes';

describe('createFunctions', () => {
  it('defines the job, the edit and export functions, seven heavy-lane functions (seven heavy tasks) plus product ingest sharing one env-scoped key, and the janitor', async () => {
    const m = await makeDeps();
    try {
      const fns = createFunctions(m.deps);
      // v4: id() is the bare opts.id; id(prefix) is the app-prefixed id Inngest routes invokes by.
      const ids = fns.map((f) => f.id(inngest.id));
      expect(ids.sort()).toEqual(['adforge-gpu-generate-ads', 'adforge-gpu-heavy-broll', 'adforge-gpu-heavy-plates', 'adforge-gpu-heavy-plateVision', 'adforge-gpu-heavy-render', 'adforge-gpu-heavy-voice', 'adforge-gpu-heavy-voiceLines', 'adforge-gpu-heavy-plateLines', 'adforge-gpu-variant-edit', 'adforge-gpu-variant-export', 'adforge-gpu-janitor', 'adforge-gpu-product-ingest'].sort());
      expect(HEAVY_CONCURRENCY).toEqual([{ scope: 'env', key: '"heavy"', limit: 1 }]);
      const heavy = fns.filter((f) => f.id().startsWith('heavy-'));
      expect(heavy).toHaveLength(7);
      for (const f of heavy) expect(f.opts.concurrency).toEqual(HEAVY_CONCURRENCY);
      expect(fns.find((f) => f.id() === 'variant-edit')!.opts).toMatchObject({ retries: 2, triggers: [{ event: 'adforge/variant.edit' }] });
      expect(fns.find((f) => f.id() === 'variant-export')!.opts).toMatchObject({ triggers: [{ event: 'adforge/variant.export' }], concurrency: expect.arrayContaining([{ key: 'event.data.revisionId', limit: 1 }]) });
      const ingest = fns.find((f) => f.id() === 'product-ingest')!;
      expect(ingest.opts).toMatchObject({ concurrency: HEAVY_CONCURRENCY, priority: { run: '600' }, triggers: [{ event: 'adforge/product.ingest' }] });
    } finally {
      await m.close();
    }
  });
});

describe('makeInngest', () => {
  it('is the adforge-gpu app; prod is cloud mode, dev is dev mode', () => {
    expect(makeInngest('prod').mode).toBe('cloud');
    expect(makeInngest('dev').mode).toBe('dev');
    expect(makeInngest(undefined).mode).toBe('dev');
    expect(makeInngest('prod').id).toBe('adforge-gpu');
  });
});
