import { PIPELINE, type PipelineConfig } from '../config/pipeline';
import type { Effort, LLMProvider, LLMResult, ProviderResult } from '../providers/types';
import type { Registry } from '../vocab/registry';
import { loadPrompt } from './prompts';
import { renderStrategistUser, type ProductInput } from './render';
import { strategistOutput, type StrategistOutput } from './schemas';

export interface LlmDeps {
  llm: LLMProvider;
  model: string;
  effort: Effort;
  idempotencyKey: string;
  cfg?: PipelineConfig;
}

export async function strategize(
  input: { product: ProductInput; images: { mime: 'image/png' | 'image/jpeg' | 'image/webp'; data: Uint8Array }[] },
  registry: Registry,
  deps: LlmDeps,
): Promise<ProviderResult<LLMResult<StrategistOutput>>> {
  const cfg = deps.cfg ?? PIPELINE;
  const archetypes = registry.archetypes.filter((a) => a.status === 'active').map((a) => a.slug);
  return deps.llm.generate({
    system: loadPrompt('strategist').text,
    user: [...input.images.map((i) => ({ type: 'image' as const, mime: i.mime, data: i.data })), { type: 'text', text: renderStrategistUser(input.product, registry) }],
    schema: strategistOutput(archetypes),
    model: deps.model,
    effort: deps.effort,
    idempotencyKey: deps.idempotencyKey,
    timeoutMs: cfg.llm.timeoutMs,
  });
}
