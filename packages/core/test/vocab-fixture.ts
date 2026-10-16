import type { FormatEntry, HookEntry, Registry, RegistryEntry } from '../src/vocab/registry';

const arch = (slug: string): RegistryEntry => ({ slug, name: slug, family: null, status: 'active', fitsArchetypes: [], definition: slug });
const fmt = (slug: string, family: string, fits: string[], beats = ['a', 'b', 'c', 'd']): FormatEntry => ({
  slug, name: slug, family, status: 'active', fitsArchetypes: fits, definition: slug, beats,
});
const hook = (slug: string, family: string): HookEntry => ({
  slug, name: slug, family, status: 'active', fitsArchetypes: [], definition: slug, shape: slug, skeleton: slug,
});

/** Mirrors packages/db/src/seed/vocabulary.ts (families per spec §5.1). */
export const REGISTRY: Registry = {
  archetypes: ['gifting', 'identity', 'indulgence', 'remedy', 'trust', 'upgrade', 'utility'].map(arch),
  formats: [
    fmt('before_after', 'narrative_arc', ['remedy', 'upgrade']),
    fmt('listicle_3', 'rational', []),
    fmt('objection_kill', 'persuasion', ['trust', 'utility']),
    fmt('problem_solution', 'narrative_arc', ['remedy', 'utility', 'trust']),
    fmt('sensory_tease', 'sensory', ['indulgence']),
    fmt('spec_flex', 'rational', ['upgrade', 'utility']),
    fmt('styling_moment', 'sensory', ['identity', 'gifting']),
    fmt('ugc_testimonial', 'social_proof', ['remedy', 'trust', 'indulgence']),
  ],
  hooks: [
    hook('confession', 'contrarian'),
    hook('curiosity_gap', 'tension'),
    hook('demonstration', 'evidence'),
    hook('direct_call', 'targeting'),
    hook('objection_lead', 'objection'),
    hook('pattern_break', 'contrarian'),
    hook('stat_shock', 'evidence'),
  ],
};

export const clone = (): Registry => structuredClone(REGISTRY);
