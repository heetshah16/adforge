import { PIPELINE } from '../config/pipeline';
import { ProviderError, type LLMContent, type LLMResult, type ProviderResult } from '../providers/types';
import type { Violation } from '../vocab/diversity';
import type { Language } from '../vocab/enums';
import type { Registry } from '../vocab/registry';
import type { Shortlist } from '../vocab/shortlist';
import { loadPrompt } from './prompts';
import { renderDirectorUser, renderRepair, type ProductInput } from './render';
import { checkDirection } from './rules';
import { directorOutput, type DirectorOutput, type StrategistOutput } from './schemas';
import type { LlmDeps } from './strategize';

/** Every provider call made, in order (first call, then repair), so callers can account for usage and cost. */
export type DirectCall = { idempotencyKey: string; result: ProviderResult<LLMResult<DirectorOutput>> };

export type DirectResult =
  | { status: 'ok'; output: DirectorOutput; repairs: number; calls: DirectCall[] }
  | { status: 'violations'; output: DirectorOutput; violations: Violation[]; repairs: number; calls: DirectCall[] }
  | { status: 'failed'; error: ProviderError; retryable: boolean; calls: DirectCall[] };

// Generic leading words that are not brands ("The Ghee Co", "Pure Desi Ghee").
const NOT_BRANDS = new Set(['the', 'pure', 'organic', 'fresh', 'homemade', 'premium', 'natural', 'new', 'original', 'best', 'real', 'desi', 'special', 'super']);

/** Explicit brand wins; else the first name token if it is long enough and not generic; else '' (check skipped). */
function brandOf(p: ProductInput): string {
  const explicit = p.brand?.trim();
  if (explicit) return explicit;
  const first = p.name.trim().split(/\s+/)[0] ?? '';
  return [...first].length >= 4 && !NOT_BRANDS.has(first.toLowerCase()) ? first : '';
}

export async function direct(
  input: { product: ProductInput; brief: StrategistOutput; shortlist: Shortlist; registry: Registry; language: Language },
  deps: LlmDeps,
): Promise<DirectResult> {
  const cfg = deps.cfg ?? PIPELINE;
  const system = loadPrompt('director').text;
  const schema = directorOutput(input.shortlist, input.language);
  const base: LLMContent = {
    type: 'text',
    text: renderDirectorUser(input.product, input.brief, input.shortlist, input.registry, input.language, cfg),
  };
  // ponytail: with no explicit brand, the first name token is a guess (>=4 code points, not generic); wire a brand field from the upload form
  const ctx = { registry: input.registry, shortlist: input.shortlist, brandName: brandOf(input.product), language: input.language, cfg };

  let user: LLMContent[] = [base];
  const calls: DirectCall[] = [];
  for (let attempt = 0; ; attempt++) {
    const idempotencyKey = attempt === 0 ? deps.idempotencyKey : `${deps.idempotencyKey}:repair${attempt}`;
    const r = await deps.llm.generate({
      system,
      user,
      schema,
      model: deps.model,
      effort: deps.effort,
      idempotencyKey,
      timeoutMs: cfg.llm.timeoutMs,
    });
    calls.push({ idempotencyKey, result: r });
    if (r.status !== 'done') {
      return r.status === 'failed'
        ? { status: 'failed', error: r.error, retryable: r.retryable, calls }
        : { status: 'failed', error: new ProviderError('llm', 'UPSTREAM', 'LLM returned pending'), retryable: true, calls };
    }
    const output = r.value.value;
    const violations = checkDirection(output, ctx);
    if (violations.length === 0) return { status: 'ok', output, repairs: attempt, calls };
    if (attempt >= cfg.diversity.repairPasses) return { status: 'violations', output, violations, repairs: attempt, calls };
    user = [base, { type: 'text', text: renderRepair(violations, output) }];
  }
}
