import { describe, expect, it } from 'vitest';
import { direct } from '../src/llm/direct';
import { loadPrompt } from '../src/llm/prompts';
import type { DirectorOutput } from '../src/llm/schemas';
import type { Shortlist } from '../src/vocab/shortlist';
import { fakeLLM } from './fake-llm';
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
  });

  it('repairs once, naming the violation verbatim, then succeeds', async () => {
    const llm = fakeLLM([collide(), anchor()]);
    const r = await direct(input, deps(llm));
    expect(r).toMatchObject({ status: 'ok', repairs: 1 });
    const repair = llm.calls[1]!;
    expect(repair.idempotencyKey).toBe('job1:direct:repair1');
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
  });

  it('propagates a provider failure without retrying it itself', async () => {
    const llm = {
      id: 'down',
      generate: async () => ({ status: 'failed' as const, error: Object.assign(new Error('limit'), { provider: 'x', code: 'RATE_LIMIT' as const }) as never, retryable: true }),
    };
    const r = await direct(input, { llm, model: 'm', effort: 'high', idempotencyKey: 'k' });
    expect(r).toMatchObject({ status: 'failed', retryable: true });
  });
});
