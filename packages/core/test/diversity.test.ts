import { describe, expect, it } from 'vitest';
import { assertVariantDiversity, offShortlist } from '../src/vocab/diversity';
import { REGISTRY } from './vocab-fixture';

const v = (hookSlug: string, formatSlug: string) => ({ hookSlug, formatSlug });

describe('assertVariantDiversity', () => {
  it('passes three hook families and two format families', () => {
    expect(
      assertVariantDiversity(
        [v('pattern_break', 'problem_solution'), v('stat_shock', 'ugc_testimonial'), v('curiosity_gap', 'problem_solution')],
        REGISTRY,
      ),
    ).toEqual([]);
  });

  it('fails three distinct hook slugs that span only two families (near-synonyms), naming the family', () => {
    const out = assertVariantDiversity(
      [v('pattern_break', 'problem_solution'), v('confession', 'ugc_testimonial'), v('stat_shock', 'objection_kill')],
      REGISTRY,
    );
    expect(out.map((x) => x.rule)).toEqual(['hook_family']);
    expect(out[0]!.message).toContain('contrarian');
    expect(out[0]!.message).toContain('pattern_break');
    expect(out[0]!.message).toContain('confession');
  });

  it('fails when every format is in one family, even with distinct format slugs', () => {
    const out = assertVariantDiversity(
      [v('pattern_break', 'problem_solution'), v('stat_shock', 'before_after'), v('curiosity_gap', 'problem_solution')],
      REGISTRY,
    );
    expect(out.map((x) => x.rule)).toEqual(['format_family']);
    expect(out[0]!.message).toContain('narrative_arc');
    expect(out[0]!.message).toContain('problem_solution');
    expect(out[0]!.message).toContain('before_after');
  });

  it('reports unknown slugs instead of throwing', () => {
    const out = assertVariantDiversity(
      [v('pattern_brake', 'problem_solution'), v('stat_shock', 'ugc_testimonial'), v('curiosity_gap', 'telenovela')],
      REGISTRY,
    );
    expect(out.filter((x) => x.rule === 'unknown_slug').map((x) => x.message).join()).toMatch(/pattern_brake.*telenovela|telenovela.*pattern_brake/s);
  });

  it('honours configured minimums', () => {
    const two = [v('pattern_break', 'problem_solution'), v('stat_shock', 'before_after')];
    expect(assertVariantDiversity(two, REGISTRY, { minHookFamilies: 2, minFormatFamilies: 1, repairPasses: 1 })).toEqual([]);
  });
});

describe('offShortlist', () => {
  it('flags slugs the Director was not offered', () => {
    const out = offShortlist([v('pattern_break', 'sensory_tease')], { formats: ['problem_solution'], hooks: ['pattern_break'] });
    expect(out).toEqual([{ rule: 'off_shortlist', message: 'format "sensory_tease" was not on the shortlist' }]);
  });
});
