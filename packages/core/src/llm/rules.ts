import { PIPELINE, type PipelineConfig } from '../config/pipeline';
import { assertVariantDiversity, offShortlist, type Violation } from '../vocab/diversity';
import type { Language } from '../vocab/enums';
import type { Registry } from '../vocab/registry';
import type { Shortlist } from '../vocab/shortlist';
import type { DirectorOutput, DirectorVariant } from './schemas';

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
const chars = (s: string) => [...s].length;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Unicode-aware word boundary: \b is ASCII-only and breaks Devanagari (combining marks are \p{M}).
const WORD = '[\\p{L}\\p{M}\\p{N}]';
// Leading boundary always, so glued tokens ("SattvikOil", "#sattvikoil") still match. Trailing boundary only for
// brands under 5 code points, so "Oil" does not flag "oily"; longer brands are distinctive enough to match as prefixes.
const brandRe = (w: string) => new RegExp(`(?<!${WORD})${esc(w)}${[...w].length < 5 ? `(?!${WORD})` : ''}`, 'iu');

export function checkVariant(
  v: DirectorVariant,
  ctx: { registry: Registry; brandName: string; language: Language; cfg?: PipelineConfig },
): Violation[] {
  const cfg = ctx.cfg ?? PIPELINE;
  const out: Violation[] = [];
  const add = (rule: Violation['rule'], message: string) => out.push({ rule, message: `variant ${v.variant_no}: ${message}` });

  const beats = ctx.registry.formats.find((f) => f.slug === v.format)?.beats;
  if (beats && v.scenes.length !== beats.length) add('beats', `format "${v.format}" has ${beats.length} beats (${beats.join(' → ')}), got ${v.scenes.length} scenes`);
  if (v.language !== ctx.language) add('language', `language must be "${ctx.language}", got "${v.language}"`);

  const first = v.scenes[0];
  if (first) {
    const { maxWords, maxChars, bannedOpeners } = cfg.hook;
    if (words(first.vo) > maxWords) add('hook_rule', `spoken hook (scene 1 VO) has ${words(first.vo)} words, max ${maxWords} words`);
    if (words(v.hook_text) > maxWords) add('hook_rule', `hook_text has ${words(v.hook_text)} words, max ${maxWords} words`);
    if (chars(first.overlay) > maxChars) add('hook_rule', `on-screen hook has ${chars(first.overlay)} characters, max ${maxChars}`);
    for (const [label, text] of [['hook_text', v.hook_text], ['scene 1 VO', first.vo]] as const) {
      const opener = bannedOpeners.find((b) => new RegExp(`^${esc(b)}(?!${WORD})`, 'iu').test(text.trim()));
      if (opener) add('hook_rule', `${label} starts with banned opener "${opener}"`);
    }
    const brand = ctx.brandName.trim();
    if (brand) {
      const re = brandRe(brand);
      for (const [label, text] of [['hook_text', v.hook_text], ['scene 1 VO', first.vo], ['scene 1 overlay', first.overlay]] as const) {
        if (re.test(text)) add('hook_rule', `${label} names the brand "${ctx.brandName}"`);
      }
    }
  }

  v.scenes.forEach((s, i) => {
    if (chars(s.overlay) > cfg.hook.maxChars) add('copy', `scene ${i + 1} overlay has ${chars(s.overlay)} characters, max ${cfg.hook.maxChars}`);
    const cap = Math.ceil(s.duration * cfg.timing.voWordsPerSec);
    if (words(s.vo) > cap) add('copy', `scene ${i + 1} VO has ${words(s.vo)} words, max ${cap}`);
    const [lo, hi] = i === 0 ? cfg.timing.hookBeatSec : cfg.timing.beatSec;
    if (s.duration < lo || s.duration > hi) add('timing', `scene ${i + 1} duration ${s.duration}s outside ${lo}–${hi}s`);
  });
  const total = v.scenes.reduce((n, s) => n + s.duration, 0);
  if (Math.abs(total - cfg.timing.totalSec) > 2) add('timing', `total ${total}s, expected about ${cfg.timing.totalSec}s (±2)`);
  return out;
}

export function checkDirection(
  out: DirectorOutput,
  ctx: { registry: Registry; shortlist: Shortlist; brandName: string; language: Language; cfg?: PipelineConfig },
): Violation[] {
  const cfg = ctx.cfg ?? PIPELINE;
  const picks = out.variants.map((v) => ({ hookSlug: v.hook_archetype, formatSlug: v.format }));
  const exp = ctx.shortlist.experimental;
  const offered = {
    formats: [...ctx.shortlist.formats.map((f) => f.slug), ...(exp?.kind === 'format' ? [exp.slug] : [])],
    hooks: [...ctx.shortlist.hooks.map((h) => h.slug), ...(exp?.kind === 'hook' ? [exp.slug] : [])],
  };
  const violations = [
    ...out.variants.flatMap((v) => checkVariant(v, ctx)),
    ...offShortlist(picks, offered),
    ...assertVariantDiversity(picks, ctx.registry, cfg.diversity),
  ];
  const third = out.variants.find((v) => v.variant_no === 3);
  if (exp && third && (exp.kind === 'format' ? third.format : third.hook_archetype) !== exp.slug) {
    violations.push({ rule: 'exploratory', message: `variant 3 must use the exploratory ${exp.kind} "${exp.slug}"` });
  }
  return violations;
}
