import { z } from 'zod';
import { ProviderError } from '@adforge/core/providers/types';

const P = 'voice-service';
const MAX_DETAIL = 500;
/** Deterministic client errors: resending the same request cannot succeed. */
const INVALID_STATUS = new Set([400, 404, 413, 422]);

const Health = z.object({ ok: z.boolean(), device: z.string(), cuda: z.boolean(), sm120: z.boolean(), loaded: z.object({ tts: z.boolean(), whisper: z.boolean() }) });
const Aligned = z.object({ text: z.string(), words: z.array(z.object({ text: z.string(), start: z.number(), end: z.number() })) });
const Unloaded = z.object({ unloaded: z.array(z.string()) });

/** Single classifier for every failure: a timed-out or aborted signal is TIMEOUT, anything else UPSTREAM. */
function classify(e: unknown, what: string, timeoutMs: number): ProviderError {
  const name = (e as Error | undefined)?.name;
  if (name === 'TimeoutError' || name === 'AbortError') return new ProviderError(P, 'TIMEOUT', `voice service ${what} timed out after ${timeoutMs}ms`, e);
  return new ProviderError(P, 'UPSTREAM', `voice service ${what} failed: ${(e as Error | undefined)?.message ?? String(e)}`, e);
}

export class VoiceClient {
  private readonly baseUrl: string;
  constructor(baseUrl: string, private readonly fetchImpl: typeof fetch = fetch, private readonly timeoutMs = 120_000) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  /** Every body read goes through here, so a stall or reset is classified, never leaked raw. */
  async #read<T>(path: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof ProviderError) throw e;
      throw classify(e, path, this.timeoutMs);
    }
  }

  async #request(path: string, init?: RequestInit): Promise<Response> {
    const what = `${init?.method ?? 'GET'} ${path}`;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (e) {
      throw classify(e, `${what} (${this.baseUrl})`, this.timeoutMs);
    }
    if (!res.ok) {
      const detail = (await this.#read(what, () => res.text())).slice(0, MAX_DETAIL);
      if (INVALID_STATUS.has(res.status)) throw new ProviderError(P, 'INVALID_INPUT', `voice service rejected ${what} (HTTP ${res.status}): ${detail}`);
      throw new ProviderError(P, 'UPSTREAM', `${what} -> HTTP ${res.status}: ${detail}`);
    }
    return res;
  }

  protected async json<T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> {
    const res = await this.#request(path, init);
    const body = await this.#read(path, () => res.json());
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new ProviderError(P, 'UPSTREAM', `unexpected ${path} response: ${z.prettifyError(parsed.error)}`);
    return parsed.data;
  }

  health() {
    return this.json('/health', Health);
  }

  async synthesize(body: object): Promise<{ bytes: Uint8Array; durationSec: number }> {
    const res = await this.#request('/synthesize', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const durationSec = Number(res.headers.get('x-duration-sec'));
    if (!Number.isFinite(durationSec) || durationSec <= 0) throw new ProviderError(P, 'UPSTREAM', 'voice service returned no X-Duration-Sec');
    const bytes = await this.#read('/synthesize', () => res.arrayBuffer());
    return { bytes: new Uint8Array(bytes), durationSec };
  }

  align(wav: Uint8Array, language: 'en' | 'hi') {
    const form = new FormData();
    form.append('audio', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'voice.wav');
    form.append('language', language);
    return this.json('/align', Aligned, { method: 'POST', body: form });
  }

  unload() {
    return this.json('/unload', Unloaded, { method: 'POST' });
  }
}
