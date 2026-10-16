import { describe, expect, it } from 'vitest';
import { PIPELINE } from '../src/config/pipeline';
import { loadPrompt } from '../src/llm/prompts';
import { checkDirection, checkVariant } from '../src/llm/rules';
import type { DirectorOutput, DirectorVariant } from '../src/llm/schemas';
import { shortlist } from '../src/vocab/shortlist';
import { REGISTRY } from './vocab-fixture';

/** The worked anchor inside director.md is the canonical valid output — the rules must accept it. */
function anchor(): DirectorOutput {
  const text = loadPrompt('director').text;
  const json = text.slice(text.indexOf('```json') + 7, text.lastIndexOf('```'));
  return JSON.parse(json) as DirectorOutput;
}
const ctx = { registry: REGISTRY, brandName: 'Sattvik', language: 'en' as const };
const v1 = (): DirectorVariant => structuredClone(anchor().variants[0]!);

describe('checkVariant', () => {
  it('accepts every variant of the worked anchor', () => {
    for (const v of anchor().variants) expect(checkVariant(v, ctx)).toEqual([]);
  });

  it('rejects the brand in the hook in any case', () => {
    const v = v1();
    v.hook_text = 'SATTVIK oil is different.';
    expect(checkVariant(v, ctx).map((x) => x.rule)).toContain('hook_rule');
  });

  it('matches the brand as a whole word, Unicode-aware', () => {
    // Scene 1 of the anchor contains "oil" as a real word, so neutralise it to test hook_text alone.
    const brandMsgs = (c: typeof ctx, text: string) => {
      const v = v1();
      v.hook_text = text;
      v.scenes[0]!.vo = 'Plain words here.';
      v.scenes[0]!.overlay = 'Plain';
      return checkVariant(v, c).filter((x) => x.message.includes('names the brand')).map((x) => x.message);
    };
    const oil = { ...ctx, brandName: 'Oil' };
    expect(brandMsgs(oil, 'No more toil in the kitchen')).toEqual([]);
    expect(brandMsgs(oil, 'Oil that tastes real')).toHaveLength(1);
    expect(brandMsgs({ ...ctx, brandName: 'सत्त्विक' }, 'असली सत्त्विक स्वाद')).toHaveLength(1);
    const meta = { ...ctx, brandName: 'C++' };
    expect(() => brandMsgs(meta, 'Try C++ today')).not.toThrow();
    expect(brandMsgs(meta, 'Try C++ today')).toHaveLength(1);
  });

  it('matches banned openers only as whole words at the start', () => {
    const cfg = { ...PIPELINE, hook: { ...PIPELINE.hook, bannedOpeners: ['Did'] } };
    const openerMsgs = (text: string) => {
      const v = v1();
      v.hook_text = text;
      return checkVariant(v, { ...ctx, cfg }).filter((x) => /banned opener/.test(x.message));
    };
    expect(openerMsgs("Didn't know oil could do that")).toEqual([]);
    expect(openerMsgs('Did you know this oil works?')).toHaveLength(1);
  });

  it('rejects banned openers and over-long hooks', () => {
    const v = v1();
    v.scenes[0]!.vo = 'Introducing the oil your mother wished she had found sooner.';
    const rules = checkVariant(v, ctx).map((x) => x.message).join('\n');
    expect(rules).toMatch(/banned opener/);
    expect(rules).toMatch(/9 words/);
  });

  it('caps overlay characters by code point, including Devanagari and ₹', () => {
    const v = v1();
    v.scenes[2]!.overlay = '₹'.repeat(29);
    expect(checkVariant(v, ctx).map((x) => x.rule)).toContain('copy');
    const ok = v1();
    ok.scenes[2]!.overlay = 'असली स्वाद, बिल्कुल शुद्ध';
    expect(checkVariant(ok, ctx)).toEqual([]);
  });

  it('caps VO words per scene from duration × pace', () => {
    const v = v1();
    v.scenes[0]!.duration = 4; // cap = ceil(4 × 2.5) = 10
    v.scenes[1]!.vo = Array.from({ length: 14 }, () => 'word').join(' '); // 5s → cap 13
    expect(checkVariant(v, ctx).map((x) => x.message).join()).toMatch(/scene 2 VO has 14 words, max 13/);
  });

  it('enforces scene-1 and other-scene duration ranges and the total', () => {
    const v = v1();
    v.scenes[0]!.duration = 6;
    expect(checkVariant(v, ctx).map((x) => x.rule)).toContain('timing');
  });

  it('requires one scene per format beat and the requested language', () => {
    const v = v1();
    v.scenes.pop();
    expect(checkVariant(v, ctx).map((x) => x.rule)).toContain('beats');
    const h = v1();
    expect(checkVariant(h, { ...ctx, language: 'hi' }).map((x) => x.rule)).toContain('language');
  });
});

describe('checkDirection', () => {
  const list = shortlist({ archetypePrimary: 'remedy', archetypeSecondary: 'trust' }, REGISTRY);

  it('accepts the anchor against an unrestricted shortlist', () => {
    const all = {
      formats: REGISTRY.formats.map((f) => ({ slug: f.slug, family: f.family, score: 1, reason: '' })),
      hooks: REGISTRY.hooks.map((h) => ({ slug: h.slug, family: h.family, score: 1, reason: '' })),
      experimental: null,
    };
    expect(checkDirection(anchor(), { ...ctx, shortlist: all })).toEqual([]);
  });

  it('flags off-shortlist slugs and family collisions', () => {
    const out = anchor();
    out.variants[2]!.hook_archetype = 'curiosity_gap'; // same family as variant 1 (tension)
    const rules = checkDirection(out, { ...ctx, shortlist: list }).map((x) => x.rule);
    expect(rules).toContain('hook_family');
    expect(rules).toContain('off_shortlist'); // sensory_tease is not on the remedy+trust shortlist
  });

  it('requires variant 3 to use the exploratory slot when one is offered', () => {
    const withExp = { ...list, experimental: { kind: 'hook' as const, slug: 'stat_shock', family: 'evidence', score: 0.5, reason: '' } };
    const rules = checkDirection(anchor(), { ...ctx, shortlist: withExp }).map((x) => x.rule);
    expect(rules).toContain('exploratory');
  });

  it('requires variant 3 format to be the experimental format slug', () => {
    const expFmt = { ...list, experimental: { kind: 'format' as const, slug: 'listicle_3', family: 'rational', score: 0.5, reason: '' } };
    const out = anchor();
    expect(out.variants[2]!.format).not.toBe('listicle_3');
    expect(checkDirection(out, { ...ctx, shortlist: expFmt }).map((x) => x.rule)).toContain('exploratory');
  });
});
