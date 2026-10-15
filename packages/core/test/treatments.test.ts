import { describe, expect, it } from 'vitest';
import { TREATMENTS } from '../src/config/treatments';
import { Motion, VisualTreatment } from '../src/vocab/enums';

describe('treatments', () => {
  it('has an entry for every visual treatment and nothing else', () => {
    expect(Object.keys(TREATMENTS).sort()).toEqual([...VisualTreatment.options].sort());
  });
  it('uses only known motions and non-empty plate suffixes', () => {
    for (const t of Object.values(TREATMENTS)) {
      expect(Motion.options).toContain(t.defaultMotion);
      expect(t.platePromptSuffix.length).toBeGreaterThan(20);
    }
  });
});
