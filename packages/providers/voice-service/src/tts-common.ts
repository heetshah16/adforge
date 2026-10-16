import { z } from 'zod';
import { ProviderError, isRetryable, type ProviderResult } from '@adforge/core/providers/types';
import { Language } from '@adforge/core/vocab/enums';

export const TtsReq = z.object({ text: z.string().min(1).max(500), language: Language, emotion: z.number().min(0).max(1), idempotencyKey: z.string().min(1) });

/** Every failure becomes a ProviderResult. Non-provider errors (storage read/put) are UPSTREAM and retryable. */
export const asFailed = (e: unknown): ProviderResult<never> => {
  const error = e instanceof ProviderError ? e : new ProviderError('voice-service', 'UPSTREAM', `voice adapter failed: ${(e as Error | undefined)?.message ?? String(e)}`, e);
  return { status: 'failed', error, retryable: isRetryable(error.code) };
};
