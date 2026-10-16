import { describe, expect, it } from 'vitest';
import { directorOutput } from '../src/llm/schemas';
import { z } from 'zod';
import { direct } from '../src/llm/direct';
import { loadPrompt } from '../src/llm/prompts';
import type { DirectorOutput } from '../src/llm/schemas';
import type { Shortlist } from '../src/vocab/shortlist';
import { failed, fakeLLM } from './fake-llm';
import { REGISTRY } from './vocab-fixture';

const anchor = (): DirectorOutput => {
  const t = loadPrompt('director').text;
  return JSON.parse(t.slice(t.indexOf('```json') + 7, t.lastIndexOf('```')));
};
const all: Shortlist = {
  formats: REGISTRY.formats.map((f) => ({ slug: f.slug, family: f.family, score: 1, reason: 'test' })),
  hooks: REGISTRY.hooks.map((h) => ({ slug: h.slug, family: h.family, score: 1, reason: 'test' })),
  experimental: null,
};
const input = {
  product: { name: 'Sattvik Oil', price: '₹450', description: 'Wood-pressed groundnut oil.' },
  brief: {
    product: { name: 'Sattvik Oil', one_liner: 'oil', price_signal: 'premium' as const, price_note: '3x' },
    archetype_primary: 'remedy', archetype_secondary: 'trust', audience: 'a', core_objection: 'b',
    differentiators: ['no hexane'], rationale: 'c', confidence: 'high' as const,
  },
  shortlist: all,
  registry: REGISTRY,
  language: 'en' as const,
};
const deps = (llm: ReturnType<typeof fakeLLM>) => ({ llm, model: 'claude-opus-5-5', effort: 'high' as const, idempotencyKey: 'job1:direct' });
const collide = () => {
  const o = anchor();
  o.variants[2]!.hook_archetype = 'curiosity_gap'; // same hook twice → family "tension" used by two variants
  return o;
};

describe('direct', () => {
  it('returns ok on a valid first answer with no repair', async () => {
    const llm = fakeLLM([anchor()]);
    const r = await direct(input, deps(llm));
    expect(r).toMatchObject({ status: 'ok', repairs: 0 });
    expect(llm.calls[0]!.system).toBe(loadPrompt('director').text);
    expect(llm.calls[0]!.user).toHaveLength(1);
    expect(r.calls.map((c) => c.idempotencyKey)).toEqual(['job1:direct']);
    expect(r.calls[0]!.result.status).toBe('done');
  });

  it('repairs once, naming the violation verbatim, then succeeds', async () => {
    const llm = fakeLLM([collide(), anchor()]);
    const r = await direct(input, deps(llm));
    expect(r).toMatchObject({ status: 'ok', repairs: 1 });
    const repair = llm.calls[1]!;
    expect(repair.idempotencyKey).toBe('job1:direct:repair1');
    expect(r.calls.map((c) => c.idempotencyKey)).toEqual(['job1:direct', 'job1:direct:repair1']);
    const text = repair.user.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
    expect(text).toContain('[hook_family]');
    expect(text).toContain('hook family "tension"'); // P4 renders a repeated slug as 'is used by more than one variant (hook family "tension")'
    expect(text).toContain('YOUR PREVIOUS OUTPUT');
  });

  it('returns the violations when the repair also fails', async () => {
    const llm = fakeLLM([collide(), collide()]);
    const r = await direct(input, deps(llm));
    expect(r.status).toBe('violations');
    expect(r.status === 'violations' && r.violations.map((v) => v.rule)).toContain('hook_family');
    expect(llm.calls).toHaveLength(2);
    expect(r.status === 'violations' && r.calls).toHaveLength(2);
  });

  it('returns the provider failure when the repair call fails, after exactly two calls', async () => {
    const llm = fakeLLM([collide(), failed('RATE_LIMIT')]);
    const r = await direct(input, deps(llm));
    expect(r).toMatchObject({ status: 'failed', retryable: true, error: { code: 'RATE_LIMIT' } });
    expect(llm.calls).toHaveLength(2);
    expect(r.status === 'failed' && r.calls.map((c) => c.result.status)).toEqual(['done', 'failed']);
  });

  const hookWith = (text: string) => { const o = anchor(); o.variants[0]!.hook_text = text; return o; };
  const brandHit = (r: Awaited<ReturnType<typeof direct>>) =>
    r.status === 'violations' && r.violations.some((v) => v.message.includes('names the brand'));

  it('does not treat a generic first word ("The") as the brand', async () => {
    const o = hookWith('The oil is different.');
    const r = await direct({ ...input, product: { ...input.product, name: 'The Ghee Co' } }, deps(fakeLLM([o, o])));
    expect(brandHit(r)).toBe(false);
  });

  it('skips the brand check for "Pure Desi Ghee"', async () => {
    const o = hookWith('Pure oil is different.');
    const r = await direct({ ...input, product: { ...input.product, name: 'Pure Desi Ghee' } }, deps(fakeLLM([o, o])));
    expect(brandHit(r)).toBe(false);
  });

  it('uses an explicit brand over the name', async () => {
    const o = hookWith('Krishna oil is different.');
    const r = await direct({ ...input, product: { ...input.product, name: 'Special Hing', brand: 'Krishna' } }, deps(fakeLLM([o, o])));
    expect(brandHit(r)).toBe(true);
  });

  it('still flags a distinctive first token when no brand is given', async () => {
    const o = hookWith('Sattvik oil is different.');
    expect(brandHit(await direct(input, deps(fakeLLM([o, o]))))).toBe(true);
  });

  it('does not render the brand into the seller JSON', async () => {
    const llm = fakeLLM([anchor()]);
    await direct({ ...input, product: { ...input.product, brand: 'Zzyzx' } }, deps(llm));
    expect(JSON.stringify(llm.calls[0]!.user)).not.toContain('Zzyzx');
  });

  it('renders the exploratory format with its beats in the Director message', async () => {
    const f = REGISTRY.formats.find((x) => x.slug === 'listicle_3')!;
    const sl = { ...all, formats: all.formats.filter((x) => x.slug !== 'listicle_3'), experimental: { kind: 'format' as const, slug: 'listicle_3', family: f.family, score: 1, reason: 'explore' } };
    const llm = fakeLLM([anchor(), anchor()]);
    await direct({ ...input, shortlist: sl }, deps(llm));
    const text = llm.calls[0]!.user.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
    expect(text).toContain(`EXPLORATORY SLOT`);
    expect(text).toContain(f.beats.join(' → '));
  });

  it('catches the brand when the product name has leading whitespace', async () => {
    const hook = anchor();
    hook.variants[0]!.hook_text = 'Sattvik oil is different.';
    const llm = fakeLLM([hook, hook]);
    const r = await direct({ ...input, product: { ...input.product, name: '  Sattvik Oil' } }, deps(llm));
    expect(r.status === 'violations' && r.violations.some((v) => v.rule === 'hook_rule' && v.message.includes('names the brand'))).toBe(true);
  });

  it('propagates a provider failure without retrying it itself', async () => {
    const llm = {
      id: 'down',
      generate: async () => ({ status: 'failed' as const, error: Object.assign(new Error('limit'), { provider: 'x', code: 'RATE_LIMIT' as const }) as never, retryable: true }),
    };
    const r = await direct(input, { llm, model: 'm', effort: 'high', idempotencyKey: 'k' });
    expect(r).toMatchObject({ status: 'failed', retryable: true });
  });

  it('turns a pending result into a real ProviderError', async () => {
    const llm = { id: 'p', generate: async () => ({ status: 'pending' as const }) } as never;
    const r = await direct(input, { llm, model: 'm', effort: 'high', idempotencyKey: 'k' });
    expect(r.status === 'failed' && r.error.code).toBe('UPSTREAM');
    expect(r.status === 'failed' && r.error.provider).toBe('llm');
  });

  it('builds the same JSON schema for every language', () => {
    expect(z.toJSONSchema(directorOutput(all, 'en'))).toEqual(z.toJSONSchema(directorOutput(all, 'hi')));
  });
});
