import { z } from 'zod';
import { ProviderError } from '@adforge/core/providers/types';
import type { SynthBody } from './params';

const P = 'voice-service';
const Health = z.object({ ok: z.boolean(), device: z.string(), cuda: z.boolean(), sm120: z.boolean(), loaded: z.object({ tts: z.boolean(), whisper: z.boolean() }) });
const Aligned = z.object({ text: z.string(), words: z.array(z.object({ text: z.string(), start: z.number(), end: z.number() })) });
const Unloaded = z.object({ unloaded: z.array(z.string()) });

export class VoiceClient {
  private readonly baseUrl: string;
  constructor(baseUrl: string, private readonly fetchImpl: typeof fetch = fetch, private readonly timeoutMs = 120_000) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async #request(path: string, init?: RequestInit): Promise<Response> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
      if (res.status === 422) throw new ProviderError(P, 'INVALID_INPUT', `voice service rejected ${path}: ${await res.text()}`);
      if (!res.ok) throw new ProviderError(P, 'UPSTREAM', `${init?.method ?? 'GET'} ${path} -> HTTP ${res.status}`);
      return res;
    } catch (e) {
      if (e instanceof ProviderError) throw e;
      if ((e as Error).name === 'TimeoutError') throw new ProviderError(P, 'TIMEOUT', `voice service ${path} timed out after ${this.timeoutMs}ms`, e);
      throw new ProviderError(P, 'UPSTREAM', `voice service unreachable at ${this.baseUrl}: ${(e as Error).message}`, e);
    }
  }

  async #json<T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> {
    const res = await this.#request(path, init);
    const parsed = schema.safeParse(await res.json().catch(() => null));
    if (!parsed.success) throw new ProviderError(P, 'UPSTREAM', `unexpected ${path} response: ${z.prettifyError(parsed.error)}`);
    return parsed.data;
  }

  health() {
    return this.#json('/health', Health);
  }

  async synthesize(body: SynthBody): Promise<{ bytes: Uint8Array; durationSec: number }> {
    const res = await this.#request('/synthesize', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const durationSec = Number(res.headers.get('x-duration-sec'));
    if (!Number.isFinite(durationSec) || durationSec <= 0) throw new ProviderError(P, 'UPSTREAM', 'voice service returned no X-Duration-Sec');
    return { bytes: new Uint8Array(await res.arrayBuffer()), durationSec };
  }

  align(wav: Uint8Array, language: 'en' | 'hi') {
    const form = new FormData();
    form.append('audio', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'voice.wav');
    form.append('language', language);
    return this.#json('/align', Aligned, { method: 'POST', body: form });
  }

  unload() {
    return this.#json('/unload', Unloaded, { method: 'POST' });
  }
}
