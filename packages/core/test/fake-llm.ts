import { ProviderError, isRetryable, type LLMProvider, type LLMRequest, type LLMResult, type ProviderErrorCode, type ProviderResult } from '../src/providers/types';

const FAILED = Symbol('fakeLLM.failed');
/** A canned response that makes the fake return a `failed` result instead of a value. */
export const failed = (code: ProviderErrorCode) => ({ [FAILED]: true, error: new ProviderError('fake', code, code), retryable: isRetryable(code) });

/** Returns each canned response in turn (validated through the request's schema) and records every request. */
export function fakeLLM(responses: unknown[]) {
  const calls: LLMRequest<unknown>[] = [];
  const llm: LLMProvider = {
    id: 'fake',
    async generate<T>(req: LLMRequest<T>): Promise<ProviderResult<LLMResult<T>>> {
      calls.push(req as LLMRequest<unknown>);
      const next = responses.shift();
      if (next === undefined) throw new Error('fakeLLM: no response left');
      if (typeof next === 'object' && next !== null && FAILED in next) {
        const f = next as unknown as { error: ProviderError; retryable: boolean };
        return { status: 'failed', error: f.error, retryable: f.retryable };
      }
      const value = req.schema.parse(next);
      return { status: 'done', value: { value, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 } }, cost: { amountUsd: 0, estimated: true }, latencyMs: 1 };
    },
  };
  return Object.assign(llm, { calls });
}
