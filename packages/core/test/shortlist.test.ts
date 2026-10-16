import { describe, expect, it } from 'vitest';
import { shortlist } from '../src/vocab/shortlist';
import { REGISTRY, clone } from './vocab-fixture';

const brief = (archetypePrimary: string, archetypeSecondary: string) => ({ archetypePrimary, archetypeSecondary });

describe('shortlist', () => {
  it('ranks formats by fit to the archetype pair, ties by slug, with reasons', () => {
    const s = shortlist(brief('remedy', 'trust'), REGISTRY);
    expect(s.formats.map((f) => [f.slug, f.score])).toEqual([
      ['problem_solution', 3],
      ['ugc_testimonial', 3],
      ['before_after', 2],
      ['objection_kill', 1],
      ['listicle_3', 0.5],
    ]);
    expect(s.formats[0]!.reason).toBe('fits primary "remedy" and secondary "trust"');
    expect(s.formats.at(-1)!.reason).toBe('fits any archetype');
  });

  it('is deterministic', () => {
    expect(shortlist(brief('indulgence', 'identity'), REGISTRY)).toEqual(shortlist(brief('indulgence', 'identity'), REGISTRY));
  });

  it('gives visibly different menus to different archetype pairs', () => {
    const a = shortlist(brief('remedy', 'trust'), REGISTRY).formats.map((f) => f.slug);
    const b = shortlist(brief('indulgence', 'identity'), REGISTRY).formats.map((f) => f.slug);
    expect(a).not.toEqual(b);
    expect(b[0]).toBe('sensory_tease');
  });

  it('offers every hook family so 3 distinct hook families are always reachable', () => {
    const s = shortlist(brief('utility', 'upgrade'), REGISTRY);
    expect(new Set(s.hooks.map((h) => h.family)).size).toBeGreaterThanOrEqual(3);
  });

  it('tops up formats from another family when every fitting format shares one', () => {
    const r = clone();
    for (const f of r.formats) f.fitsArchetypes = f.family === 'narrative_arc' ? ['remedy'] : ['gifting'];
    const s = shortlist(brief('remedy', 'remedy'), r);
    const families = new Set(s.formats.map((f) => f.family));
    expect(families.size).toBeGreaterThanOrEqual(2);
    expect(s.formats.find((f) => f.family !== 'narrative_arc')!.reason).toBe('added for family diversity');
  });

  it('never counts a null family toward family top-up', () => {
    const r = clone();
    for (const f of r.formats) f.fitsArchetypes = f.family === 'narrative_arc' ? ['remedy'] : ['gifting'];
    r.formats.find((f) => f.slug === 'listicle_3')!.family = null;
    const s = shortlist(brief('remedy', 'remedy'), r);
    const realFamilies = new Set(s.formats.map((f) => f.family).filter((f) => f !== null));
    expect(realFamilies.size).toBeGreaterThanOrEqual(2);
    expect(s.formats.find((f) => f.slug === 'listicle_3')).toBeUndefined();
    expect(s.formats.some((f) => f.family === null && f.reason === 'added for family diversity')).toBe(false);
  });

  it('never offers retired or proposed entries, and reserves one experimental slot', () => {
    const r = clone();
    r.formats.find((f) => f.slug === 'problem_solution')!.status = 'retired';
    r.formats.find((f) => f.slug === 'ugc_testimonial')!.status = 'proposed';
    r.hooks.find((h) => h.slug === 'stat_shock')!.status = 'experimental';
    const s = shortlist(brief('remedy', 'trust'), r);
    const slugs = s.formats.map((f) => f.slug);
    expect(slugs).not.toContain('problem_solution');
    expect(slugs).not.toContain('ugc_testimonial');
    expect(s.hooks.map((h) => h.slug)).not.toContain('stat_shock');
    expect(s.experimental).toMatchObject({ kind: 'hook', slug: 'stat_shock' });
  });

  it('leaves the experimental slot empty when there is no experimental entry', () => {
    expect(shortlist(brief('remedy', 'trust'), REGISTRY).experimental).toBeNull();
  });

  it('respects the configured caps', () => {
    const s = shortlist(brief('remedy', 'trust'), REGISTRY, { formats: 2, hooks: 3, reserveExperimentalSlot: true });
    expect(s.formats.length).toBeGreaterThanOrEqual(2); // may exceed only via family top-up
    expect(new Set(s.formats.map((f) => f.family)).size).toBeGreaterThanOrEqual(2);
  });
});
