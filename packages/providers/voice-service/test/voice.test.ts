import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ProviderError } from '@adforge/core/providers/types';
import { VoiceClient } from '../src/client';
import { asrLanguage, voiceParams } from '../src/params';
import { createVoiceProviders } from '../src/providers';

const BASE = 'http://127.0.0.1:8190';
const fixture = (n: string) => JSON.parse(readFileSync(new URL(`../fixtures/${n}`, import.meta.url), 'utf8'));
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

function fake(routes: Record<string, (req: Request) => Response | Promise<Response>>) {
  const bodies: Record<string, unknown> = {};
  const f = (async (input: string | Request | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const key = `${req.method} ${new URL(req.url).pathname}`;
    if (req.headers.get('content-type')?.includes('json')) bodies[key] = await req.clone().json();
    if (!routes[key]) throw new Error(`unrouted ${key}`);
    return routes[key]!(req);
  }) as typeof fetch;
  return Object.assign(f, { bodies });
}

function memStorage() {
  const files = new Map<string, Uint8Array>();
  return {
    id: 'mem',
    files,
    async put(bytes: Uint8Array, opts: { mime: string; durationSec?: number }) {
      const id = `ab/${'a'.repeat(63)}${files.size}.wav`;
      files.set(id, bytes);
      return { id, url: `http://localhost:3000/media/${id}`, mime: opts.mime, sha256: 'x', bytes: bytes.length, durationSec: opts.durationSec };
    },
    async read(key: string) {
      return files.get(key)!;
    },
  };
}

describe('voiceParams', () => {
  it('maps emotion linearly onto the exaggeration range and lowers cfg when expressive', () => {
    expect(voiceParams('hi there', 'en', 0)).toEqual({ text: 'hi there', language_id: 'en', exaggeration: 0.4, cfg_weight: 0.5 });
    expect(voiceParams('x', 'en', 0.5).exaggeration).toBeCloseTo(0.55, 6);
  });
  it('caps the expressive peak at exaggeration 0.7 and lowers cfg above the threshold', () => {
    expect(voiceParams('x', 'en', 1.0)).toMatchObject({ exaggeration: 0.7, cfg_weight: 0.45 });
  });
  it('routes Hinglish through the configured TTS and ASR language ids', () => {
    expect(voiceParams('Bilkul sahi', 'hinglish', 0.5).language_id).toBe('hi');
    expect(asrLanguage('hinglish')).toBe('hi');
    expect(asrLanguage('en')).toBe('en');
  });
  it('produces the golden request body', async () => {
    await expect(JSON.stringify(voiceParams('Nobody tells you how oil is made.', 'en', 0.6), null, 2) + '\n').toMatchFileSnapshot('./golden/synthesize-body.json');
  });
});

describe('VoiceClient', () => {
  it('returns WAV bytes and the duration header', async () => {
    const live = fixture('synthesize.live.json');
    const f = fake({ 'POST /synthesize': () => new Response(new Uint8Array([82, 73, 70, 70]), { headers: { 'content-type': 'audio/wav', 'x-duration-sec': live.durationSec } }) });
    const r = await new VoiceClient(BASE, f).synthesize(voiceParams('x', 'en', 0.5));
    expect(r.durationSec).toBeCloseTo(Number(live.durationSec), 6);
    expect(r.bytes.length).toBe(4);
  });

  it('parses the recorded live alignment', async () => {
    const f = fake({ 'POST /align': () => json(fixture('align.live.json')) });
    const r = await new VoiceClient(BASE, f).align(new Uint8Array([1]), 'en');
    expect(r.words.length).toBeGreaterThan(3);
    expect(r.words.every((w) => w.end >= w.start)).toBe(true);
  });

  it('maps a 422 to INVALID_INPUT (our schema was wrong)', async () => {
    const f = fake({ 'POST /synthesize': () => json({ detail: [{ msg: 'too long' }] }, 422) });
    const err = await new VoiceClient(BASE, f).synthesize(voiceParams('x', 'en', 0.5)).catch((e: unknown) => e);
    expect((err as ProviderError).code).toBe('INVALID_INPUT');
  });

  it('times out a hung service as a retryable TIMEOUT', async () => {
    const hung = ((_: unknown, init?: RequestInit) =>
      new Promise((_r, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)))) as typeof fetch;
    const err = await new VoiceClient(BASE, hung, 25).synthesize(voiceParams('x', 'en', 0.5)).catch((e: unknown) => e);
    expect((err as ProviderError).code).toBe('TIMEOUT');
  });

  it.each([
    [400, 'INVALID_INPUT'],
    [404, 'INVALID_INPUT'],
    [413, 'INVALID_INPUT'],
    [422, 'INVALID_INPUT'],
    [503, 'UPSTREAM'],
  ] as const)('maps HTTP %i to %s', async (status, code) => {
    const f = fake({ 'POST /synthesize': () => new Response('nope', { status }) });
    const err = await new VoiceClient(BASE, f).synthesize(voiceParams('x', 'en', 0.5)).catch((e: unknown) => e);
    expect((err as ProviderError).code).toBe(code);
  });

  it('truncates the echoed response detail to 500 characters', async () => {
    const f = fake({ 'POST /synthesize': () => new Response('x'.repeat(2000), { status: 422 }) });
    const err = (await new VoiceClient(BASE, f).synthesize(voiceParams('x', 'en', 0.5)).catch((e: unknown) => e)) as ProviderError;
    expect(err.message.length).toBeLessThan(600);
  });

  it('classifies a body stream that resets after headers as UPSTREAM, not a raw rejection', async () => {
    const reset = (async () => {
      const body = new ReadableStream({ start(c) { c.error(new TypeError('socket reset')); } });
      return new Response(body, { status: 200, headers: { 'x-duration-sec': '1' } });
    }) as typeof fetch;
    const err = await new VoiceClient(BASE, reset).synthesize(voiceParams('x', 'en', 0.5)).catch((e: unknown) => e);
    expect((err as ProviderError).code).toBe('UPSTREAM');
  });

  it('classifies a body that never ends as a retryable TIMEOUT within the deadline', async () => {
    const stalls = (async (_: unknown, init?: RequestInit) => {
      const body = new ReadableStream({
        start(c) {
          init?.signal?.addEventListener('abort', () => c.error(init.signal!.reason));
        },
      });
      return new Response(body, { status: 200, headers: { 'x-duration-sec': '1' } });
    }) as typeof fetch;
    const started = Date.now();
    const err = await new VoiceClient(BASE, stalls, 25).synthesize(voiceParams('x', 'en', 0.5)).catch((e: unknown) => e);
    expect((err as ProviderError).code).toBe('TIMEOUT');
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('createVoiceProviders', () => {
  it('stores synthesized audio with its measured duration', async () => {
    const storage = memStorage();
    const f = fake({ 'POST /synthesize': () => new Response(new Uint8Array([1, 2]), { headers: { 'x-duration-sec': '2.500000' } }) });
    const { tts } = createVoiceProviders({ baseUrl: BASE, storage, fetchImpl: f });
    const r = await tts.synthesize({ text: 'hello', language: 'en', emotion: 0.4, idempotencyKey: 'k' });
    expect(r.status === 'done' && r.value).toMatchObject({ mime: 'audio/wav', durationSec: 2.5 });
    expect(f.bodies['POST /synthesize']).toMatchObject({ language_id: 'en' });
  });

  it('rejects an invalid TTS request before dispatch', async () => {
    const f = fake({});
    const { tts } = createVoiceProviders({ baseUrl: BASE, storage: memStorage(), fetchImpl: f });
    const r = await tts.synthesize({ text: 'x'.repeat(501), language: 'en', emotion: 0.4, idempotencyKey: 'k' });
    expect(r.status === 'failed' && r.error.code).toBe('INVALID_INPUT');
  });

  it('aligns stored audio and converts to AlignedWord seconds', async () => {
    const storage = memStorage();
    const ref = await storage.put(new Uint8Array([9]), { mime: 'audio/wav' });
    const f = fake({ 'POST /align': () => json({ text: 'a b', words: [{ text: 'a', start: 0.1, end: 0.3 }, { text: 'b', start: 0.3, end: 0.6 }] }) });
    const { aligner } = createVoiceProviders({ baseUrl: BASE, storage, fetchImpl: f });
    const r = await aligner.align({ audio: ref, text: 'a b', language: 'en', idempotencyKey: 'k' });
    expect(r.status === 'done' && r.value.words).toEqual([{ text: 'a', startSec: 0.1, endSec: 0.3 }, { text: 'b', startSec: 0.3, endSec: 0.6 }]);
  });

  it('returns a retryable failed result, never a rejection, when the body stream resets', async () => {
    const reset = (async () => {
      const body = new ReadableStream({ start(c) { c.error(new TypeError('socket reset')); } });
      return new Response(body, { status: 200, headers: { 'x-duration-sec': '1' } });
    }) as typeof fetch;
    const { tts } = createVoiceProviders({ baseUrl: BASE, storage: memStorage(), fetchImpl: reset });
    const r = await tts.synthesize({ text: 'hello', language: 'en', emotion: 0.4, idempotencyKey: 'k' });
    expect(r.status === 'failed' && [r.error.code, r.retryable]).toEqual(['UPSTREAM', true]);
  });
});
