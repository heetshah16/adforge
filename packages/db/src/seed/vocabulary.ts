/**
 * Source: docs/adforge-build-spec.md §3–4. Edit this file and run `pnpm db:seed` to
 * regroup families or add entries. Never rename or delete a slug — retire it instead.
 * New entries default to `proposed` (set no status); only mark `active` after review/evidence.
 */

type SeedStatus = 'proposed' | 'experimental' | 'active';

export interface VocabSeed {
  families: { kind: 'archetype' | 'format' | 'hook'; slug: string; name: string }[];
  archetypes: { status?: SeedStatus; slug: string; name: string; buyingDriver: string; definition: string; examples: string[] }[];
  formats: {
    status?: SeedStatus;
    slug: string;
    family: string;
    name: string;
    beats: string[];
    fitsArchetypes: string[];
    definition: string;
  }[];
  hooks: {
    status?: SeedStatus;
    slug: string;
    family: string;
    name: string;
    shape: string;
    skeleton: string;
    fitsArchetypes: string[];
  }[];
}

export const VOCAB: VocabSeed = {
  families: [
    { kind: 'hook', slug: 'contrarian', name: 'Contrarian' },
    { kind: 'hook', slug: 'targeting', name: 'Targeting' },
    { kind: 'hook', slug: 'evidence', name: 'Evidence' },
    { kind: 'hook', slug: 'tension', name: 'Tension' },
    { kind: 'hook', slug: 'objection', name: 'Objection' },
    { kind: 'format', slug: 'narrative_arc', name: 'Narrative arc' },
    { kind: 'format', slug: 'social_proof', name: 'Social proof' },
    { kind: 'format', slug: 'rational', name: 'Rational' },
    { kind: 'format', slug: 'sensory', name: 'Sensory' },
    { kind: 'format', slug: 'persuasion', name: 'Persuasion' },
  ],
  archetypes: [
    { status: 'active', slug: 'remedy', name: 'Remedy', buyingDriver: 'Solves a felt pain', definition: 'Bought to make a felt problem go away.', examples: ['skincare', 'cleaning', 'pain relief', 'health foods'] },
    { status: 'active', slug: 'upgrade', name: 'Upgrade', buyingDriver: 'Better version of something owned', definition: 'Bought to replace something the buyer already has with a better one.', examples: ['gadgets', 'cookware', 'tools', 'luggage'] },
    { status: 'active', slug: 'indulgence', name: 'Indulgence', buyingDriver: 'Sensory or emotional want', definition: 'Bought for pleasure rather than need.', examples: ['snacks', 'beverages', 'fragrance', 'dessert'] },
    { status: 'active', slug: 'identity', name: 'Identity', buyingDriver: 'Signals who the buyer is', definition: 'Bought for what owning it says about the buyer.', examples: ['apparel', 'jewellery', 'sneakers', 'decor'] },
    { status: 'active', slug: 'utility', name: 'Utility', buyingDriver: 'Rational time/money saving', definition: 'Bought on a rational calculation of time or money saved.', examples: ['services', 'SaaS', 'storage', 'stationery'] },
    { status: 'active', slug: 'gifting', name: 'Gifting', buyingDriver: 'Bought for someone else', definition: 'Bought to be given; the recipient’s reaction is the payoff.', examples: ['hampers', 'toys', 'occasion items'] },
    { status: 'active', slug: 'trust', name: 'Trust', buyingDriver: 'High-consideration, risk-reducing', definition: 'Bought only once the buyer believes the risk is low.', examples: ['baby products', 'health devices', "kids' food"] },
  ],
  formats: [
    { status: 'active', slug: 'problem_solution', family: 'narrative_arc', name: 'Problem → solution', beats: ['pain', 'agitate', 'reveal', 'relief'], fitsArchetypes: ['remedy', 'utility', 'trust'], definition: 'Name a pain, make it worse, reveal the product, show relief.' },
    { status: 'active', slug: 'ugc_testimonial', family: 'social_proof', name: 'UGC testimonial', beats: ['to-camera hook', 'skepticism', 'try', 'verdict'], fitsArchetypes: ['remedy', 'trust', 'indulgence'], definition: 'A real-seeming person doubts, tries, and gives a verdict.' },
    { status: 'active', slug: 'before_after', family: 'narrative_arc', name: 'Before / after', beats: ['state A', 'trigger', 'state B', 'proof'], fitsArchetypes: ['remedy', 'upgrade'], definition: 'Show the state before, the product as trigger, the state after, then proof.' },
    { status: 'active', slug: 'spec_flex', family: 'rational', name: 'Spec flex', beats: ['claim', 'demo', 'comparison', 'price anchor'], fitsArchetypes: ['upgrade', 'utility'], definition: 'Lead with a hard claim, demonstrate it, compare, anchor the price.' },
    { status: 'active', slug: 'sensory_tease', family: 'sensory', name: 'Sensory tease', beats: ['extreme close-up', 'texture', 'reaction', 'want'], fitsArchetypes: ['indulgence'], definition: 'Sell the sensation through close-ups and a reaction.' },
    { status: 'active', slug: 'styling_moment', family: 'sensory', name: 'Styling moment', beats: ['context', 'product enters', 'transformation', 'look'], fitsArchetypes: ['identity', 'gifting'], definition: 'The product enters a scene and transforms the look.' },
    { status: 'active', slug: 'objection_kill', family: 'persuasion', name: 'Objection kill', beats: ['state doubt', 'escalate', 'counter-proof', 'CTA'], fitsArchetypes: ['trust', 'utility'], definition: 'Voice the buyer’s doubt, then dismantle it with proof.' },
    { status: 'active', slug: 'listicle_3', family: 'rational', name: 'Listicle (3 reasons)', beats: ['"3 reasons"', 'reason', 'reason', 'winner'], fitsArchetypes: [], definition: 'Three reasons, the last one the strongest. Fallback for any archetype.' },
  ],
  hooks: [
    { status: 'active', slug: 'pattern_break', family: 'contrarian', name: 'Pattern break', shape: 'Contradicts expectation', skeleton: 'Stop buying [obvious thing].', fitsArchetypes: [] },
    { status: 'active', slug: 'direct_call', family: 'targeting', name: 'Direct call', shape: 'Names the viewer', skeleton: 'If you [trait], watch this.', fitsArchetypes: [] },
    { status: 'active', slug: 'stat_shock', family: 'evidence', name: 'Stat shock', shape: "Number that doesn't fit intuition", skeleton: '[N]% of [X] contains [Y].', fitsArchetypes: [] },
    { status: 'active', slug: 'confession', family: 'contrarian', name: 'Confession', shape: 'Admits something', skeleton: 'I was wrong about [category].', fitsArchetypes: [] },
    { status: 'active', slug: 'curiosity_gap', family: 'tension', name: 'Curiosity gap', shape: 'Withholds the payoff', skeleton: "Nobody checks what's inside [X].", fitsArchetypes: [] },
    { status: 'active', slug: 'demonstration', family: 'evidence', name: 'Demonstration', shape: 'Opens mid-action, no preamble', skeleton: 'Product already doing the thing.', fitsArchetypes: [] },
    { status: 'active', slug: 'objection_lead', family: 'objection', name: 'Objection lead', shape: 'Voices the doubt first', skeleton: "Yes, it's 3x the price. Here's why.", fitsArchetypes: [] },
  ],
};
