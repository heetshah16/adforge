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
});
