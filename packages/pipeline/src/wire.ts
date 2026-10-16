import type { ProviderErrorCode, ProviderResult } from '@adforge/core/providers/types';

/** step.run results are JSON — ProviderError (non-enumerable message) must be flattened explicitly. */
export type WireResult<T> = { ok: true; value: T } | { ok: false; code: ProviderErrorCode; message: string; retryable: boolean };

export function toWire<T>(r: ProviderResult<T>): WireResult<T> {
  if (r.status === 'done') return { ok: true, value: r.value };
  if (r.status === 'failed') return { ok: false, code: r.error.code, message: r.error.message, retryable: r.retryable };
  return { ok: false, code: 'TIMEOUT', message: `still pending (${r.handle.externalId})`, retryable: true };
}
