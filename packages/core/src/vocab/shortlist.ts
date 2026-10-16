import { PIPELINE, type PipelineConfig } from '../config/pipeline';
import type { Registry, RegistryEntry } from './registry';

export interface Ranked {
  slug: string;
  family: string | null;
  score: number;
  reason: string;
}
export interface Shortlist {
  formats: Ranked[];
  hooks: Ranked[];
  experimental: (Ranked & { kind: 'format' | 'hook' }) | null;
}
type Brief = { archetypePrimary: string; archetypeSecondary: string };

function rank(e: RegistryEntry, b: Brief): Ranked {
  if (e.fitsArchetypes.length === 0) return { slug: e.slug, family: e.family, score: 0.5, reason: 'fits any archetype' };
  const p = e.fitsArchetypes.includes(b.archetypePrimary);
  const s = b.archetypeSecondary !== b.archetypePrimary && e.fitsArchetypes.includes(b.archetypeSecondary);
  const score = (p ? 2 : 0) + (s ? 1 : 0);
  const reason =
    p && s
      ? `fits primary "${b.archetypePrimary}" and secondary "${b.archetypeSecondary}"`
      : p
        ? `fits primary "${b.archetypePrimary}"`
        : s
          ? `fits secondary "${b.archetypeSecondary}"`
          : 'no archetype fit';
  return { slug: e.slug, family: e.family, score, reason };
}

// Code-unit comparison: localeCompare varies by machine ICU locale, which would make tie-breaks non-deterministic.
const bySlug = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const byScoreThenSlug = (a: Ranked, b: Ranked) => b.score - a.score || bySlug(a.slug, b.slug);

function rankKind(entries: readonly RegistryEntry[], b: Brief, cap: number, minFamilies: number): Ranked[] {
  const all = entries.filter((e) => e.status === 'active').map((e) => rank(e, b)).sort(byScoreThenSlug);
  const picked = all.filter((r) => r.score > 0).slice(0, cap);
  const families = new Set<string>(picked.flatMap((r) => (r.family === null ? [] : [r.family])));
  for (const candidate of all) {
    if (families.size >= minFamilies) break;
    if (candidate.family === null || families.has(candidate.family) || picked.includes(candidate)) continue;
    picked.push({ ...candidate, reason: 'added for family diversity' });
    families.add(candidate.family);
  }
  return picked;
}

/** Deterministic, explainable narrowing of the registry for one product (spec §6). No LLM. */
export function shortlist(
  brief: Brief,
  registry: Registry,
  cfg: PipelineConfig['shortlist'] = PIPELINE.shortlist,
  diversity: PipelineConfig['diversity'] = PIPELINE.diversity,
): Shortlist {
  const formats = rankKind(registry.formats, brief, cfg.formats, diversity.minFormatFamilies);
  const hooks = rankKind(registry.hooks, brief, cfg.hooks, diversity.minHookFamilies);

  let experimental: Shortlist['experimental'] = null;
  if (cfg.reserveExperimentalSlot) {
    const candidates = [
      ...registry.formats.filter((e) => e.status === 'experimental').map((e) => ({ ...rank(e, brief), kind: 'format' as const })),
      ...registry.hooks.filter((e) => e.status === 'experimental').map((e) => ({ ...rank(e, brief), kind: 'hook' as const })),
    ].sort((a, b) => b.score - a.score || (a.kind === b.kind ? 0 : a.kind === 'format' ? -1 : 1) || bySlug(a.slug, b.slug));
    experimental = candidates[0] ?? null;
  }
  return { formats, hooks, experimental };
}
