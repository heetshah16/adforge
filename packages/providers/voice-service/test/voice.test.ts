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
    expect(voiceParams('hi there', 'en', 0)).toEqual({ text: 'hi there', language_id: 'en', exaggeration: 0.3, cfg_weight: 0.5 });
    expect(voiceParams('x', 'en', 1)).toMatchObject({ exaggeration: 0.9, cfg_weight: 0.3 });
    expect(voiceParams('x', 'en', 0.5).exaggeration).toBeCloseTo(0.6, 6);
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
});
