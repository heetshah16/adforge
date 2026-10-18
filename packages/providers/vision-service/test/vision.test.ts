import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createVisionProviders } from '../src/providers';

const BASE = 'http://127.0.0.1:8192';
const fixture = (n: string) => JSON.parse(readFileSync(new URL(`../fixtures/${n}`, import.meta.url), 'utf8'));
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
const KEY = `ab/${'a'.repeat(64)}.png`;
const IMG = { id: KEY, url: `http://localhost:3000/media/${KEY}`, mime: 'image/png', sha256: 'x', bytes: 4 };

/** Serialise a multipart body deterministically: text fields by value, file parts by name/type/size (never bytes). */
async function formShape(req: Request) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of (await req.clone().formData()).entries()) out[k] = typeof v === 'string' ? v : { filename: v.name, type: v.type, size: v.size };
  return JSON.stringify(out, null, 2) + '\n';
}

function fake(routes: Record<string, (req: Request) => Response | Promise<Response>>) {
  const forms: Record<string, string> = {};
  const f = (async (input: string | Request | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const key = `${req.method} ${new URL(req.url).pathname}`;
    if (req.headers.get('content-type')?.includes('multipart')) forms[key] = await formShape(req);
    if (!routes[key]) throw new Error(`unrouted ${key}`);
    return routes[key]!(req);
  }) as typeof fetch;
  return Object.assign(f, { forms });
}

function memStorage() {
  const files = new Map<string, Uint8Array>([[KEY, new Uint8Array([137, 80, 78, 71])]]);
  const puts: { mime: string; width?: number; height?: number }[] = [];
  return {
    id: 'mem',
    puts,
    async put(bytes: Uint8Array, opts: { mime: string; width?: number; height?: number }) {
      puts.push(opts);
      const id = `cd/${'b'.repeat(64)}.png`;
      files.set(id, bytes);
      return { id, url: `http://localhost:3000/media/${id}`, mime: opts.mime, sha256: 'y', bytes: bytes.length, width: opts.width, height: opts.height };
    },
    async read(key: string) {
      return files.get(key)!;
    },
    urlFor: (key: string) => `http://localhost:3000/media/${key}`,
  };
}

const depthRes = () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png', 'x-depth-near': 'high', 'x-width': '640', 'x-height': '480' } });
const mk = (fetchImpl: typeof fetch, extra: { timeoutMs?: number; baseUrl?: string } = {}) =>
  createVisionProviders({ baseUrl: BASE, storage: memStorage(), fetchImpl, ...extra });

describe('golden multipart bodies', () => {
  it('depth', async () => {
    const f = fake({ 'POST /depth': depthRes });
    await mk(f).depth.estimate(IMG, 'k');
    await expect(f.forms['POST /depth']).toMatchFileSnapshot('./golden/depth-form.json');
  });
  it('ocr', async () => {
    const f = fake({ 'POST /ocr': () => json(fixture('ocr.live.json')) });
    await mk(f).ocr.read(IMG, ['en', 'hi']);
    await expect(f.forms['POST /ocr']).toMatchFileSnapshot('./golden/ocr-form.json');
  });
  it('luma', async () => {
    const f = fake({ 'POST /luma': () => json(fixture('luma.live.json')) });
    await mk(f).luma.grid(IMG, 8);
    await expect(f.forms['POST /luma']).toMatchFileSnapshot('./golden/luma-form.json');
  });
});

describe('providers', () => {
  it('stores the depth PNG with the width and height from the headers; local cost', async () => {
    const storage = memStorage();
    const p = createVisionProviders({ baseUrl: BASE, storage, fetchImpl: fake({ 'POST /depth': depthRes }) });
    const r = await p.depth.estimate(IMG, 'k');
    expect(r.status).toBe('done');
    if (r.status !== 'done') return;
    expect(storage.puts).toEqual([{ mime: 'image/png', width: 640, height: 480 }]);
    expect(r.value).toMatchObject({ mime: 'image/png', width: 640, height: 480 });
    expect(r.cost).toEqual({ amountUsd: 0, estimated: false });
  });

  it('parses the recorded live OCR and luma responses', async () => {
    const p = mk(fake({ 'POST /ocr': () => json(fixture('ocr.live.json')), 'POST /luma': () => json(fixture('luma.live.json')) }));
    const o = await p.ocr.read(IMG);
    expect(o.status === 'done' && o.value.every((i) => i.box.length === 4)).toBe(true);
    const l = await p.luma.grid(IMG);
    expect(l.status === 'done' && l.value.length > 1).toBe(true);
  });

  it('rejects bad requests locally without calling the service', async () => {
    const p = mk(fake({}));
    for (const r of [await p.luma.grid(IMG, 1), await p.luma.grid(IMG, 33), await p.ocr.read(IMG, ['fr' as 'en']), await p.depth.estimate(IMG, '')]) {
      expect(r).toMatchObject({ status: 'failed', retryable: false, error: { code: 'INVALID_INPUT' } });
    }
  });

  it.each([[400, 'INVALID_INPUT', false], [413, 'INVALID_INPUT', false], [422, 'INVALID_INPUT', false], [500, 'UPSTREAM', true], [503, 'UPSTREAM', true]] as const)('maps HTTP %i to %s', async (status, code, retryable) => {
    const p = mk(fake({ 'POST /ocr': () => json({ detail: 'x' }, status) }));
    expect(await p.ocr.read(IMG)).toMatchObject({ status: 'failed', retryable, error: { code } });
  });

  it('treats a malformed response as UPSTREAM', async () => {
    const p = mk(fake({ 'POST /luma': () => json({ grid: 'nope' }) }));
    expect(await p.luma.grid(IMG)).toMatchObject({ status: 'failed', error: { code: 'UPSTREAM' } });
  });

  it('rejects a depth response without dimension headers', async () => {
    const p = mk(fake({ 'POST /depth': () => new Response(new Uint8Array([1])) }));
    expect(await p.depth.estimate(IMG, 'k')).toMatchObject({ status: 'failed', error: { code: 'UPSTREAM' } });
  });

  it('a hung server becomes TIMEOUT (headers never arrive)', async () => {
    const hung = ((_u: unknown, init?: RequestInit) => new Promise((_res, rej) => init!.signal!.addEventListener('abort', () => rej(init!.signal!.reason)))) as unknown as typeof fetch;
    const r = await mk(hung, { timeoutMs: 30 }).luma.grid(IMG);
    expect(r).toMatchObject({ status: 'failed', retryable: true, error: { code: 'TIMEOUT' } });
  });

  it('a stalled body read becomes TIMEOUT', async () => {
    const stall = ((_u: unknown, init?: RequestInit) => {
      const body = new ReadableStream({ start(c) { init!.signal!.addEventListener('abort', () => c.error(init!.signal!.reason)); } });
      return Promise.resolve(new Response(body, { headers: { 'x-width': '1', 'x-height': '1', 'x-depth-near': 'high' } }));
    }) as unknown as typeof fetch;
    expect(await mk(stall, { timeoutMs: 30 }).depth.estimate(IMG, 'k')).toMatchObject({ status: 'failed', error: { code: 'TIMEOUT' } });
  });

  it('health and unload hit the service (trailing slashes stripped)', async () => {
    const f = fake({ 'GET /health': () => json({ ok: true, device: 'cuda:0', cuda: true, loaded: { depth: false, ocr: false }, allocated_mb: 0 }), 'POST /unload': () => json({ unloaded: ['depth'] }) });
    const p = mk(f, { baseUrl: `${BASE}//` });
    expect((await p.health()).ok).toBe(true);
    expect(await p.unload()).toEqual({ unloaded: ['depth'] });
  });
});
