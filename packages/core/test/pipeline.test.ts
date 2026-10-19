import { describe, expect, it } from 'vitest';
import { DEFAULT_PIPELINE, PIPELINE, PipelineConfig } from '../src/config/pipeline';

describe('pipeline config', () => {
  it('defaults are valid and loaded', () => {
    expect(PIPELINE.video).toEqual({ width: 1080, height: 1920, fps: 30 });
    expect(PIPELINE.diversity.minHookFamilies).toBe(3);
  });

  it('rejects an inverted range', () => {
    const bad = { ...DEFAULT_PIPELINE, timing: { ...DEFAULT_PIPELINE.timing, beatSec: [6, 5] } };
    expect(PipelineConfig.safeParse(bad).success).toBe(false);
  });

  it('rejects plate sizes that are not multiples of 16', () => {
    const bad = { ...DEFAULT_PIPELINE, plate: { width: 770, height: 1344 } };
    expect(PipelineConfig.safeParse(bad).success).toBe(false);
  });

  it('rejects a composite anchor the product cannot fit above (anchorY < heightFrac)', () => {
    const bad = { ...DEFAULT_PIPELINE, composite: { ...DEFAULT_PIPELINE.composite, supporting: { anchorX: 0.5, anchorY: 0.2, heightFrac: 0.3 } } };
    expect(PipelineConfig.safeParse(bad).error?.issues.map((i) => i.message).join()).toMatch(/anchorY/);
  });
});
