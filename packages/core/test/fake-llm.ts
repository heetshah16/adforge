import type { LLMProvider, LLMRequest, LLMResult, ProviderResult } from '../src/providers/types';

/** Returns each canned response in turn (validated through the request's schema) and records every request. */
export function fakeLLM(responses: unknown[]) {
  const calls: LLMRequest<unknown>[] = [];
  const llm: LLMProvider = {
    id: 'fake',
    async generate<T>(req: LLMRequest<T>): Promise<ProviderResult<LLMResult<T>>> {
      calls.push(req as LLMRequest<unknown>);
      const next = responses.shift();
      if (next === undefined) throw new Error('fakeLLM: no response left');
      const value = req.schema.parse(next);
      return { status: 'done', value: { value, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 } }, cost: { amountUsd: 0, estimated: true }, latencyMs: 1 };
    },
  };
  return Object.assign(llm, { calls });
}
