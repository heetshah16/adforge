import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ProviderError } from '@adforge/core/providers/types';
import { DEFAULT_PIPELINE, PipelineConfig } from '@adforge/core/config/pipeline';
import { parseEnv } from '@adforge/core/config/env';
import { createVoiceProviders } from '../src/providers';
import { QwenClient, QwenBody, createQwenTTS, qwenParams } from '../src/qwen';

const BASE = 'http://127.0.0.1:8190';
const QBASE = 'http://127.0.0.1:8191';
const live = JSON.parse(readFileSync(new URL('../fixtures/qwen-synthesize.live.json', import.meta.url), 'utf8'));
const wav = () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'x-duration-sec': live.durationSec } });

function fake(routes: Record<string, (req: Request) => Response | Promise<Response>>) {
  const calls: string[] = [];
  const bodies: Record<string, unknown> = {};
  const f = (async (input: string | Request | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const u = new URL(req.url);
    const key = `${req.method} ${u.port} ${u.pathname}`;
    calls.push(key);
    if (req.headers.get('content-type')?.includes('json')) bodies[key] = await req.clone().json();
    if (!routes[key]) throw new Error(`unrouted ${key}`);
    return routes[key]!(req);
  }) as typeof fetch;
  return Object.assign(f, { calls, bodies });
}

function memStorage() {
  const files = new Map<string, Uint8Array>();
  return {
    id: 'mem',
    async put(bytes: Uint8Array, opts: { mime: string; durationSec?: number }) {
      const id = `ab/${'a'.repeat(63)}${files.size}.wav`;
      files.set(id, bytes);
      return { id, url: `http://localhost:3000/media/${id}`, mime: opts.mime, sha256: 'x', bytes: bytes.length, durationSec: opts.durationSec };
    },
    async read(key: string) {
      return files.get(key)!;
    },
    urlFor: (key: string) => `http://localhost:3000/media/${key}`,
  };
}

type Engine = 'chatterbox' | 'qwen';
const withEngines = (en: Engine) =>
  PipelineConfig.parse({ ...DEFAULT_PIPELINE, voice: { ...DEFAULT_PIPELINE.voice, engineByLanguage: { en, hi: 'chatterbox', hinglish: 'chatterbox' } } });
const req = (language: 'en' | 'hi' | 'hinglish', emotion = 0.4) => ({ text: 'hello', language, emotion, idempotencyKey: 'k' });
const jsonRes = (b: unknown) => new Response(JSON.stringify(b), { headers: { 'content-type': 'application/json' } });

describe('config + env', () => {
  it('defaults English to qwen, hi/hinglish to chatterbox, and the Qwen URL to :8191', () => {
    expect(DEFAULT_PIPELINE.voice.engineByLanguage).toEqual({ en: 'qwen', hi: 'chatterbox', hinglish: 'chatterbox' });
    expect(parseEnv({}).ADFORGE_QWEN_TTS_URL).toBe('http://127.0.0.1:8191');
    expect(parseEnv({ ADFORGE_QWEN_TTS_URL: 'http://h:1/' }).ADFORGE_QWEN_TTS_URL).toBe('http://h:1');
  });
  it('rejects qwen for hi/hinglish (English only)', () => {
    const bad = (l: string) => PipelineConfig.parse({ ...DEFAULT_PIPELINE, voice: { ...DEFAULT_PIPELINE.voice, engineByLanguage: { ...DEFAULT_PIPELINE.voice.engineByLanguage, [l]: 'qwen' } } });
    expect(() => bad('hi')).toThrow();
    expect(() => bad('hinglish')).toThrow();
  });
  it('rejects a non-preset speaker (config and body)', () => {
    expect(() => PipelineConfig.parse({ ...DEFAULT_PIPELINE, voice: { ...DEFAULT_PIPELINE.voice, qwen: { ...DEFAULT_PIPELINE.voice.qwen, speaker: 'Bob' } } })).toThrow();
    expect(QwenBody.safeParse({ text: 'x', speaker: 'Bob' }).success).toBe(false);
  });
  it('rejects an unknown engine', () => {
    expect(() => withEngines('kokoro' as never)).toThrow();
  });
});

describe('qwenParams', () => {
  it('picks calm vs expressive instruct around the threshold', () => {
    expect(qwenParams('x', 0.75)).toEqual({ text: 'x', speaker: 'Ryan', instruct: DEFAULT_PIPELINE.voice.qwen.calmInstruct });
    expect(qwenParams('x', 0.76).instruct).toBe(DEFAULT_PIPELINE.voice.qwen.expressiveInstruct);
  });
  it('produces the golden request body', async () => {
    await expect(JSON.stringify(qwenParams('Nobody tells you how oil is made.', 0.9), null, 2) + '\n').toMatchFileSnapshot('./golden/qwen-synthesize-body.json');
  });
});

describe('QwenClient', () => {
  it.each([
    [400, 'INVALID_INPUT'],
    [404, 'INVALID_INPUT'],
    [413, 'INVALID_INPUT'],
    [422, 'INVALID_INPUT'],
    [503, 'UPSTREAM'],
  ] as const)('maps HTTP %i to %s', async (status, code) => {
    const f = fake({ 'POST 8191 /synthesize': () => new Response('nope', { status }) });
    const err = await new QwenClient(QBASE, f).synthesize(qwenParams('x', 0.5)).catch((e: unknown) => e);
    expect((err as ProviderError).code).toBe(code);
  });
  it('times out a hung service as TIMEOUT', async () => {
    const hung = ((_: unknown, init?: RequestInit) => new Promise((_r, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)))) as typeof fetch;
    const err = await new QwenClient(QBASE, hung, 25).synthesize(qwenParams('x', 0.5)).catch((e: unknown) => e);
    expect((err as ProviderError).code).toBe('TIMEOUT');
  });
});

describe('engine routing', () => {
  it('an all-chatterbox table sends every language to chatterbox and keeps id "chatterbox"', async () => {
    const f = fake({ 'POST 8190 /synthesize': wav });
    const { tts } = createVoiceProviders({ baseUrl: BASE, qwenBaseUrl: QBASE, cfg: withEngines('chatterbox'), storage: memStorage(), fetchImpl: f });
    expect(tts.id).toBe('chatterbox');
    for (const l of ['en', 'hi', 'hinglish'] as const) expect((await tts.synthesize(req(l))).status).toBe('done');
    expect(f.calls.every((c) => c.includes(' 8190 '))).toBe(true);
  });
  it('routes en to qwen (stored with measured duration) and others to chatterbox; id reflects the table', async () => {
    const f = fake({ 'POST 8190 /synthesize': wav, 'POST 8191 /synthesize': wav });
    const { tts } = createVoiceProviders({ baseUrl: BASE, qwenBaseUrl: QBASE, cfg: withEngines('qwen'), storage: memStorage(), fetchImpl: f });
    expect(tts.id).toBe('routed(en=qwen,hi=chatterbox,hinglish=chatterbox)');
    const en = await tts.synthesize(req('en', 0.9));
    expect(en.status === 'done' && en.value).toMatchObject({ mime: 'audio/wav', durationSec: Number(live.durationSec) });
    expect(f.bodies['POST 8191 /synthesize']).toMatchObject({ speaker: 'Ryan', text: 'hello' });
    await tts.synthesize(req('hi'));
    expect(f.calls).toEqual(['POST 8191 /synthesize', 'POST 8190 /synthesize']);
  });
  it("'qwen' without qwenBaseUrl is a non-retryable INVALID_INPUT", async () => {
    const { tts } = createVoiceProviders({ baseUrl: BASE, cfg: withEngines('qwen'), storage: memStorage(), fetchImpl: fake({}) });
    expect(await tts.synthesize(req('en'))).toMatchObject({ status: 'failed', retryable: false, error: { code: 'INVALID_INPUT' } });
  });
  it('QwenTTS rejects non-English and oversized text before dispatch', async () => {
    const f = fake({});
    const tts = createQwenTTS({ client: new QwenClient(QBASE, f), storage: memStorage() });
    expect(await tts.synthesize(req('hi'))).toMatchObject({ status: 'failed', retryable: false, error: { code: 'INVALID_INPUT' } });
    const big = createVoiceProviders({ baseUrl: BASE, qwenBaseUrl: QBASE, cfg: withEngines('qwen'), storage: memStorage(), fetchImpl: f }).tts;
    expect(await big.synthesize({ ...req('en'), text: 'x'.repeat(501) })).toMatchObject({ status: 'failed', error: { code: 'INVALID_INPUT' } });
    expect(f.calls).toEqual([]);
  });
  it('a 5xx from qwen is a retryable UPSTREAM failed result', async () => {
    const f = fake({ 'POST 8191 /synthesize': () => new Response('boom', { status: 503 }) });
    const { tts } = createVoiceProviders({ baseUrl: BASE, qwenBaseUrl: QBASE, cfg: withEngines('qwen'), storage: memStorage(), fetchImpl: f });
    expect(await tts.synthesize(req('en'))).toMatchObject({ status: 'failed', retryable: true, error: { code: 'UPSTREAM' } });
  });
  it('unload hits both engines (qwen best-effort) and health reports both', async () => {
    const f = fake({
      'POST 8190 /unload': () => jsonRes({ unloaded: ['tts'] }),
      'POST 8191 /unload': () => new Response('down', { status: 500 }),
      'GET 8190 /health': () => jsonRes({ ok: true, device: 'cuda', cuda: true, sm120: true, loaded: { tts: false, whisper: false } }),
      'GET 8191 /health': () => jsonRes({ ok: true, device: 'cuda', cuda: true, sm120: true, loaded: { tts: false }, allocated_mb: 0 }),
    });
    const v = createVoiceProviders({ baseUrl: BASE, qwenBaseUrl: QBASE, cfg: withEngines('qwen'), storage: memStorage(), fetchImpl: f });
    expect(await v.unload()).toEqual({ unloaded: ['tts'] });
    expect(f.calls).toContain('POST 8191 /unload');
    expect(await v.health()).toMatchObject({ ok: true, qwen: { loaded: { tts: false } } });
  });
  it('all-chatterbox routing makes no qwen calls on unload or health', async () => {
    const f = fake({
      'POST 8190 /unload': () => jsonRes({ unloaded: ['tts'] }),
      'GET 8190 /health': () => jsonRes({ ok: true, device: 'cuda', cuda: true, sm120: true, loaded: { tts: false, whisper: false } }),
    });
    const v = createVoiceProviders({ baseUrl: BASE, qwenBaseUrl: QBASE, cfg: withEngines('chatterbox'), storage: memStorage(), fetchImpl: f });
    await v.unload();
    await v.health();
    expect(f.calls.some((c) => c.includes(' 8191 '))).toBe(false);
  });
  it('idFor names the serving engine per language', () => {
    const d = createVoiceProviders({ baseUrl: BASE, cfg: withEngines('chatterbox'), storage: memStorage(), fetchImpl: fake({}) }).tts;
    expect(d.idFor('en')).toBe('chatterbox');
    const r = createVoiceProviders({ baseUrl: BASE, qwenBaseUrl: QBASE, cfg: withEngines('qwen'), storage: memStorage(), fetchImpl: fake({}) }).tts;
    expect([r.idFor('en'), r.idFor('hi')]).toEqual(['qwen-tts', 'chatterbox']);
  });
  it('unload still unloads qwen when chatterbox unload fails, and rethrows', async () => {
    const f = fake({ 'POST 8190 /unload': () => new Response('x', { status: 500 }), 'POST 8191 /unload': () => jsonRes({ unloaded: ['tts'] }) });
    const v = createVoiceProviders({ baseUrl: BASE, qwenBaseUrl: QBASE, cfg: withEngines('qwen'), storage: memStorage(), fetchImpl: f });
    await expect(v.unload()).rejects.toThrow();
    expect(f.calls).toContain('POST 8191 /unload');
  });
  it('health.ok reflects qwen only when a language routes to it', async () => {
    const routes = { 'GET 8190 /health': () => jsonRes({ ok: true, device: 'cuda', cuda: true, sm120: true, loaded: { tts: false, whisper: false } }), 'GET 8191 /health': () => new Response('x', { status: 503 }) };
    const routed = createVoiceProviders({ baseUrl: BASE, qwenBaseUrl: QBASE, cfg: withEngines('qwen'), storage: memStorage(), fetchImpl: fake(routes) });
    expect(await routed.health()).toMatchObject({ ok: false, sm120: false, qwen: null });
    const dflt = createVoiceProviders({ baseUrl: BASE, qwenBaseUrl: QBASE, cfg: withEngines('chatterbox'), storage: memStorage(), fetchImpl: fake(routes) });
    expect(await dflt.health()).toMatchObject({ ok: true, sm120: true });
  });
  it('health returns qwen: null when qwen is unreachable', async () => {
    const f = fake({ 'GET 8190 /health': () => jsonRes({ ok: true, device: 'cuda', cuda: true, sm120: true, loaded: { tts: false, whisper: false } }), 'GET 8191 /health': () => new Response('x', { status: 503 }) });
    const v = createVoiceProviders({ baseUrl: BASE, qwenBaseUrl: QBASE, cfg: withEngines('qwen'), storage: memStorage(), fetchImpl: f });
    expect(await v.health()).toMatchObject({ ok: false, qwen: null });
  });
});
