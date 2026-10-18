import { z } from 'zod';
import { ProviderError } from '@adforge/core/providers/types';
import { fetchWithDeadline, readClassified } from '@adforge/core/providers/http';
import type { QwenBody } from './qwen';
import type { SynthBody } from './params';

const P = 'voice-service';
const LABEL = 'voice service';

const Health = z.object({ ok: z.boolean(), device: z.string(), cuda: z.boolean(), sm120: z.boolean(), loaded: z.object({ tts: z.boolean(), whisper: z.boolean() }) });
const Aligned = z.object({ text: z.string(), words: z.array(z.object({ text: z.string(), start: z.number(), end: z.number() })) });
const Unloaded = z.object({ unloaded: z.array(z.string()) });

export class VoiceClient {
  private readonly baseUrl: string;
  constructor(baseUrl: string, private readonly fetchImpl: typeof fetch = fetch, private readonly timeoutMs = 120_000) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  #read<T>(path: string, fn: () => Promise<T>): Promise<T> {
    return readClassified(P, LABEL, path, this.timeoutMs, fn);
  }

  #request(path: string, init?: RequestInit): Promise<Response> {
    return fetchWithDeadline({ provider: P, label: LABEL, fetchImpl: this.fetchImpl, url: `${this.baseUrl}${path}`, init, timeoutMs: this.timeoutMs });
  }

  async #json<T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> {
    const res = await this.#request(path, init);
    const body = await this.#read(path, () => res.json());
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new ProviderError(P, 'UPSTREAM', `unexpected ${path} response: ${z.prettifyError(parsed.error)}`);
    return parsed.data;
  }

  health(): Promise<z.infer<typeof Health>>;
  health<T>(schema: z.ZodType<T>): Promise<T>;
  health(schema: z.ZodType<unknown> = Health) {
    return this.#json('/health', schema);
  }

  async synthesize(body: SynthBody | QwenBody): Promise<{ bytes: Uint8Array; durationSec: number }> {
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
    return this.#json('/align', Aligned, { method: 'POST', body: form });
  }

  unload() {
    return this.#json('/unload', Unloaded, { method: 'POST' });
  }
}
