import { PIPELINE } from '../config/pipeline';
import type { LLMContent, ProviderError } from '../providers/types';
import type { Violation } from '../vocab/diversity';
import type { Language } from '../vocab/enums';
import type { Registry } from '../vocab/registry';
import type { Shortlist } from '../vocab/shortlist';
import { loadPrompt } from './prompts';
import { renderDirectorUser, renderRepair, type ProductInput } from './render';
import { checkDirection } from './rules';
import { directorOutput, type DirectorOutput, type StrategistOutput } from './schemas';
import type { LlmDeps } from './strategize';

export type DirectResult =
  | { status: 'ok'; output: DirectorOutput; repairs: number }
  | { status: 'violations'; output: DirectorOutput; violations: Violation[]; repairs: number }
  | { status: 'failed'; error: ProviderError; retryable: boolean };

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
  // ponytail: first word of the product name is the brand; add a brand field to the upload form if this misses
  const ctx = { registry: input.registry, shortlist: input.shortlist, brandName: input.product.name.trim().split(/\s+/)[0] ?? '', language: input.language, cfg };

  let user: LLMContent[] = [base];
  for (let attempt = 0; ; attempt++) {
    const r = await deps.llm.generate({
      system,
      user,
      schema,
      model: deps.model,
      effort: deps.effort,
      idempotencyKey: attempt === 0 ? deps.idempotencyKey : `${deps.idempotencyKey}:repair${attempt}`,
      timeoutMs: cfg.llm.timeoutMs,
    });
    if (r.status !== 'done') {
      return r.status === 'failed'
        ? { status: 'failed', error: r.error, retryable: r.retryable }
        : { status: 'failed', error: new Error('LLM returned pending') as ProviderError, retryable: true };
    }
    const output = r.value.value;
    const violations = checkDirection(output, ctx);
    if (violations.length === 0) return { status: 'ok', output, repairs: attempt };
    if (attempt >= cfg.diversity.repairPasses) return { status: 'violations', output, violations, repairs: attempt };
    user = [base, { type: 'text', text: renderRepair(violations, output) }];
  }
}
