import { z } from 'zod';
import { Language, type Language as LanguageT, Motion, ProductProminence, VisualTreatment } from '../vocab/enums';
import type { Shortlist } from '../vocab/shortlist';

const enumOf = (slugs: string[], what: string) => {
  if (slugs.length === 0) throw new Error(`${what}: cannot build an output schema from an empty slug list`);
  return z.enum(slugs as [string, ...string[]]);
};

/** Built from the live registry so constrained decoding can only emit real archetype slugs. */
export function strategistOutput(archetypeSlugs: string[]) {
  const A = enumOf(archetypeSlugs, 'archetypes');
  return z.object({
    product: z.object({
      name: z.string().min(1).max(120),
      one_liner: z.string().min(1).max(200),
      price_signal: z.enum(['premium', 'mid', 'value']),
      price_note: z.string().max(200),
    }),
    archetype_primary: A,
    archetype_secondary: A,
    audience: z.string().min(1).max(300),
    core_objection: z.string().min(1).max(300),
    differentiators: z.array(z.string().min(1).max(200)).max(3),
    rationale: z.string().min(1).max(800),
    confidence: z.enum(['high', 'medium', 'low']),
  });
}
export type StrategistOutput = z.infer<ReturnType<typeof strategistOutput>>;

/** Built from the shortlist: format/hook enums contain only what the Director was offered. */
export function directorOutput(shortlist: Shortlist, _language?: LanguageT) {
  const exp = shortlist.experimental;
  const formats = [...shortlist.formats.map((f) => f.slug), ...(exp?.kind === 'format' ? [exp.slug] : [])];
  const hooks = [...shortlist.hooks.map((h) => h.slug), ...(exp?.kind === 'hook' ? [exp.slug] : [])];
  const Scene = z.object({
    beat: z.string().min(1),
    vo: z.string().min(1).max(240),
    overlay: z.string().min(1).max(60),
    scene: z.string().min(10).max(400),
    product_prominence: ProductProminence,
    duration: z.number().min(2).max(8),
    motion: Motion,
    emotion: z.number().min(0).max(1),
  });
  const Variant = z.object({
    variant_no: z.number().int().min(1).max(3),
    format: enumOf(formats, 'formats'),
    hook_archetype: enumOf(hooks, 'hooks'),
    visual_treatment: VisualTreatment,
    strategic_bet: z.string().min(10).max(300),
    hook_text: z.string().min(1).max(120),
    language: Language, // enum, not a per-job literal: keeps the schema (and the cached prefix) identical across languages
    scenes: z.array(Scene).min(3).max(6),
    cta: z.string().min(1).max(80),
    caption: z.string().min(1).max(300),
  });
  return z.object({ variants: z.array(Variant).length(3) });
}
export type DirectorOutput = z.infer<ReturnType<typeof directorOutput>>;
export type DirectorVariant = DirectorOutput['variants'][number];
