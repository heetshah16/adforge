import { PIPELINE, type PipelineConfig } from '../config/pipeline';
import { familyOf, type Registry } from './registry';

export interface Violation {
  rule: 'unknown_slug' | 'hook_family' | 'format_family' | 'off_shortlist';
  message: string;
}
export type VariantPick = { hookSlug: string; formatSlug: string };

function familyGroups(slugs: string[], entries: Registry['hooks'] | Registry['formats']) {
  const groups = new Map<string, string[]>();
  for (const slug of slugs) {
    const fam = familyOf(entries, slug);
    if (!fam) continue; // unknown slugs are reported separately
    groups.set(fam, [...(groups.get(fam) ?? []), slug]);
  }
  return groups;
}

/**
 * Distance, not distinctness: hooks must come from distinct families (at least minHookFamilies),
 * formats from at least minFormatFamilies families. Messages are written to be quoted in the repair prompt.
 */
export function assertVariantDiversity(
  variants: VariantPick[],
  registry: Registry,
  cfg: PipelineConfig['diversity'] = PIPELINE.diversity,
): Violation[] {
  const out: Violation[] = [];
  for (const { hookSlug, formatSlug } of variants) {
    if (familyOf(registry.hooks, hookSlug) === undefined) out.push({ rule: 'unknown_slug', message: `hook "${hookSlug}" is not in the vocabulary` });
    if (familyOf(registry.formats, formatSlug) === undefined) out.push({ rule: 'unknown_slug', message: `format "${formatSlug}" is not in the vocabulary` });
  }

  const hooks = familyGroups(variants.map((x) => x.hookSlug), registry.hooks);
  const shared = [...hooks].filter(([, slugs]) => slugs.length > 1);
  if (shared.length > 0 || hooks.size < Math.min(cfg.minHookFamilies, variants.length)) {
    const detail = shared
      .map(([fam, slugs]) => {
        const unique = [...new Set(slugs)];
        return unique.length === 1
          ? `"${unique[0]}" is used by more than one variant (hook family "${fam}")`
          : `${unique.map((s) => `"${s}"`).join(' and ')} share hook family "${fam}"`;
      })
      .join('; ');
    out.push({
      rule: 'hook_family',
      message: `hooks must come from ${cfg.minHookFamilies} different families, found ${hooks.size}${detail ? `: ${detail}` : ''}`,
    });
  }

  const formats = familyGroups(variants.map((x) => x.formatSlug), registry.formats);
  if (formats.size < cfg.minFormatFamilies) {
    const detail = [...formats].map(([fam, slugs]) => `"${fam}" (${[...new Set(slugs)].join(', ')})`).join(', ');
    out.push({
      rule: 'format_family',
      message: `formats must span at least ${cfg.minFormatFamilies} families, found ${formats.size}: ${detail}`,
    });
  }
  return out;
}

export function offShortlist(variants: VariantPick[], shortlist: { formats: string[]; hooks: string[] }): Violation[] {
  const out: Violation[] = [];
  for (const { hookSlug, formatSlug } of variants) {
    if (!shortlist.hooks.includes(hookSlug)) out.push({ rule: 'off_shortlist', message: `hook "${hookSlug}" was not on the shortlist` });
    if (!shortlist.formats.includes(formatSlug)) out.push({ rule: 'off_shortlist', message: `format "${formatSlug}" was not on the shortlist` });
  }
  return out;
}
