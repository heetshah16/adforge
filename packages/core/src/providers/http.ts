import { ProviderError, type ProviderErrorCode } from './types';

const MAX_DETAIL = 500;
/** Deterministic client errors: resending the same request cannot succeed. */
const INVALID_STATUS: ReadonlySet<number> = new Set([400, 404, 413, 422]);

/** 400/404/413/422 are our bug (INVALID_INPUT); everything else non-2xx is the service's (UPSTREAM). */
export function classifyStatus(status: number): ProviderErrorCode {
  return INVALID_STATUS.has(status) ? 'INVALID_INPUT' : 'UPSTREAM';
}

/** A timed-out or aborted signal is TIMEOUT, anything else UPSTREAM. `label` reads like "voice service". */
export function classifyFailure(provider: string, label: string, e: unknown, what: string, timeoutMs: number): ProviderError {
  const name = (e as Error | undefined)?.name;
  if (name === 'TimeoutError' || name === 'AbortError') return new ProviderError(provider, 'TIMEOUT', `${label} ${what} timed out after ${timeoutMs}ms`, e);
  return new ProviderError(provider, 'UPSTREAM', `${label} ${what} failed: ${(e as Error | undefined)?.message ?? String(e)}`, e);
}

/** Every body read goes through here, so a stall or reset is classified, never leaked raw. */
export async function readClassified<T>(provider: string, label: string, what: string, timeoutMs: number, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    throw classifyFailure(provider, label, e, what, timeoutMs);
  }
}

/**
 * fetch under an AbortSignal deadline that also covers the body (read it via readClassified with the same timeoutMs).
 * Non-2xx becomes a ProviderError by classifyStatus; the response is returned only when ok.
 */
export async function fetchWithDeadline(o: { provider: string; label: string; fetchImpl: typeof fetch; url: string; init?: RequestInit; timeoutMs: number }): Promise<Response> {
  const what = `${o.init?.method ?? 'GET'} ${new URL(o.url).pathname}`;
  let res: Response;
  try {
    res = await o.fetchImpl(o.url, { ...o.init, signal: AbortSignal.timeout(o.timeoutMs) });
  } catch (e) {
    throw classifyFailure(o.provider, o.label, e, `${what} (${new URL(o.url).origin})`, o.timeoutMs);
  }
  if (!res.ok) {
    const detail = (await readClassified(o.provider, o.label, what, o.timeoutMs, () => res.text())).slice(0, MAX_DETAIL);
    const code = classifyStatus(res.status);
    throw new ProviderError(o.provider, code, code === 'INVALID_INPUT' ? `${o.label} rejected ${what} (HTTP ${res.status}): ${detail}` : `${what} -> HTTP ${res.status}: ${detail}`);
  }
  return res;
}
