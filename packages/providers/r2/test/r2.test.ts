import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withStorageOrg } from '@adforge/core/providers/storage-scope';
import { ProviderError, isRetryable } from '@adforge/core/providers/types';
import { R2Config, R2Storage, headFromResponse } from '../src';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const CFG = R2Config.parse({
  accountId: '0123456789abcdef0123456789abcdef',
  accessKeyId: 'AKIDTEST',
  secretAccessKey: 'secrettest',
  bucket: 'adforge-test',
  publicUrl: 'https://app.example.com',
});
const DATETIME = '20261019T000000Z';
const BYTES = new Uint8Array([1, 2, 3, 4]);
const SHA = createHash('sha256').update(BYTES).digest('hex');
const KEY_A = `org/${ORG_A}/${SHA.slice(0, 2)}/${SHA}.png`;
const here = (p: string) => new URL(p, import.meta.url);

/** In-memory R2: objects keyed by URL path; records every request. */
function memR2() {
  const objects = new Map<string, { bytes: Uint8Array; mime: string }>();
  const calls: Request[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    calls.push(req);
    const path = new URL(req.url).pathname;
    const obj = objects.get(path);
    if (req.method === 'PUT') {
      objects.set(path, { bytes: new Uint8Array(await req.arrayBuffer()), mime: req.headers.get('content-type') ?? '' });
      return new Response(null, { status: 200 });
    }
    if (!obj) return new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 });
    const headers = { 'content-type': obj.mime, 'content-length': String(obj.bytes.byteLength) };
    return req.method === 'HEAD' ? new Response(null, { status: 200, headers }) : new Response(obj.bytes, { status: 200, headers });
  }) as typeof fetch;
  return { objects, calls, fetchImpl };
}

describe('R2Storage', () => {
  afterEach(() => vi.useRealTimers());

  it('put without a scope throws and sends no request', async () => {
    const m = memR2();
    const r2 = new R2Storage(CFG, m.fetchImpl);
    await expect(r2.put(BYTES, { mime: 'image/png' })).rejects.toThrow(/missing storage org scope/);
    expect(m.calls).toHaveLength(0);
  });

  it('put in scope writes the org key once; a repeat sends HEAD only', async () => {
    const m = memR2();
    const r2 = new R2Storage(CFG, m.fetchImpl);
    const ref = await withStorageOrg(ORG_A, () => r2.put(BYTES, { mime: 'image/png', width: 1, height: 1 }));
    expect(ref).toMatchObject({ id: KEY_A, mime: 'image/png', sha256: SHA, bytes: 4, width: 1, url: `https://app.example.com/media/${KEY_A}` });
    expect(m.calls.map((c) => c.method)).toEqual(['HEAD', 'PUT']);
    expect(m.calls[1]!.headers.get('content-type')).toBe('image/png');
    m.calls.length = 0;
    await withStorageOrg(ORG_A, () => r2.put(BYTES, { mime: 'image/png' }));
    expect(m.calls.map((c) => c.method)).toEqual(['HEAD']);
    expect(await r2.read(KEY_A)).toEqual(BYTES);
  });

  it('urlFor never contains the R2 hostname', () => {
    expect(new R2Storage(CFG, memR2().fetchImpl).urlFor(KEY_A)).toBe(`https://app.example.com/media/${KEY_A}`);
  });

  it('golden: signed PUT for a fixed datetime', async () => {
    const m = memR2();
    const r2 = new R2Storage(CFG, m.fetchImpl, () => DATETIME);
    await withStorageOrg(ORG_A, () => r2.put(BYTES, { mime: 'image/png' }));
    const put = m.calls.find((c) => c.method === 'PUT')!;
    const got = { method: put.method, url: put.url, headers: Object.fromEntries([...put.headers.entries()].sort()) };
    const path = here('./golden/put-request.json');
    if (process.env.UPDATE_GOLDEN) writeFileSync(path, JSON.stringify(got, null, 2) + '\n');
    expect(got).toEqual(JSON.parse(readFileSync(path, 'utf8')));
  });

  it('presignPut carries X-Amz-Expires, signs content-type, returns the header', async () => {
    const r2 = new R2Storage(CFG, memR2().fetchImpl, () => DATETIME);
    const { url, headers } = await r2.presignPut(KEY_A, { mime: 'image/png', bytes: 4, ttlSec: 600 });
    const u = new URL(url);
    expect(u.origin).toBe(`https://${CFG.accountId}.r2.cloudflarestorage.com`);
    expect(u.pathname).toBe(`/adforge-test/${KEY_A}`);
    expect(u.searchParams.get('X-Amz-Expires')).toBe('600');
    expect(u.searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;content-type;host;if-none-match;x-amz-checksum-sha256');
    expect(u.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    // content-length is signed but not returned: browsers set it themselves (forbidden header).
    expect(headers).toEqual({ 'content-type': 'image/png', 'x-amz-checksum-sha256': Buffer.from(SHA, 'hex').toString('base64'), 'if-none-match': '*' });
  });

  it('presignGet carries X-Amz-Expires and rejects a ttl over 7 days', async () => {
    const r2 = new R2Storage(CFG, memR2().fetchImpl);
    const u = new URL(await r2.presignGet(KEY_A, 300));
    expect(u.searchParams.get('X-Amz-Expires')).toBe('300');
    await expect(r2.presignGet(KEY_A, 604_801)).rejects.toThrow();
  });

  it('presignGet download adds a signed response-content-disposition; absent otherwise', async () => {
    const r2 = new R2Storage(CFG, memR2().fetchImpl);
    const d = new URL(await r2.presignGet(KEY_A, 300, { download: true }));
    expect(d.searchParams.get('response-content-disposition')).toMatch(/^attachment; filename="adforge-[0-9a-f]{64}\.[a-z0-9]+"$/);
    expect(d.searchParams.get('X-Amz-SignedHeaders')).toBeTruthy();
    expect(d.searchParams.get('X-Amz-Signature')).toBeTruthy();
    const plain = new URL(await r2.presignGet(KEY_A, 300, { download: false }));
    expect(plain.searchParams.has('response-content-disposition')).toBe(false);
    expect(d.searchParams.get('X-Amz-Signature')).not.toBe(plain.searchParams.get('X-Amz-Signature'));
  });

  it('a stalled fetch becomes a retryable TIMEOUT', async () => {
    vi.useFakeTimers();
    let started!: () => void;
    const fetchStarted = new Promise<void>((r) => (started = r));
    const stalled = ((_i: unknown, init?: RequestInit) => {
      started();
      return new Promise((_, rej) => init!.signal!.addEventListener('abort', () => rej(init!.signal!.reason ?? new DOMException('aborted', 'AbortError'))));
    }) as unknown as typeof fetch;
    const r2 = new R2Storage({ ...CFG, timeoutMs: 1000 }, stalled);
    const p = r2.head(KEY_A).catch((e) => e);
    await fetchStarted; // signing is real async crypto; the deadline timer starts before fetch
    await vi.advanceTimersByTimeAsync(1001);
    const e = await p;
    expect(e).toBeInstanceOf(ProviderError);
    expect(e.code).toBe('TIMEOUT');
    expect(isRetryable(e.code)).toBe(true);
  });

  it('5xx is retryable UPSTREAM; 403 is non-retryable AUTH', async () => {
    const mk = (status: number) => new R2Storage(CFG, (async () => new Response('x', { status })) as typeof fetch);
    const e5 = await mk(503).head(KEY_A).catch((e) => e);
    expect([e5.code, isRetryable(e5.code)]).toEqual(['UPSTREAM', true]);
    const e4 = await mk(403).head(KEY_A).catch((e) => e);
    expect([e4.code, isRetryable(e4.code)]).toEqual(['AUTH', false]);
    const e429 = await mk(429).head(KEY_A).catch((e) => e);
    expect([e429.code, isRetryable(e429.code)]).toEqual(['RATE_LIMIT', true]);
  });

  it('error detail carries only the R2 <Code>, not the body; a PUT 404 (NoSuchBucket) is non-retryable', async () => {
    const body = '<Error><Code>NoSuchBucket</Code><Message>secret-ish detail</Message></Error>';
    const r2 = new R2Storage(CFG, (async (_u: unknown, init?: RequestInit) => new Response(init?.method === 'HEAD' ? null : body, { status: init?.method === 'HEAD' ? 404 : 404 })) as typeof fetch);
    const e = await withStorageOrg(ORG_A, () => r2.put(BYTES, { mime: 'image/png' })).catch((x) => x);
    expect(e.code).toBe('INVALID_INPUT');
    expect(isRetryable(e.code)).toBe(false);
    expect(e.message).toContain('NoSuchBucket');
    expect(e.message).not.toContain('secret-ish');
  });

  it('headFromResponse throws on a missing or non-numeric content-length or a missing content-type', () => {
    expect(() => headFromResponse(200, new Headers({ 'content-type': 'image/png' }))).toThrow(ProviderError);
    expect(() => headFromResponse(200, new Headers({ 'content-type': 'image/png', 'content-length': 'abc' }))).toThrow(ProviderError);
    expect(() => headFromResponse(200, new Headers({ 'content-length': '4' }))).toThrow(ProviderError);
    expect(headFromResponse(200, new Headers({ 'content-type': 'image/png', 'content-length': '4' }))).toEqual({ bytes: 4, mime: 'image/png' });
  });

  it('PUT sends If-None-Match: * and the payload sha256', async () => {
    const m = memR2();
    await withStorageOrg(ORG_A, () => new R2Storage(CFG, m.fetchImpl).put(BYTES, { mime: 'image/png' }));
    const put = m.calls.find((c) => c.method === 'PUT')!;
    expect(put.headers.get('if-none-match')).toBe('*');
    expect(put.headers.get('x-amz-content-sha256')).toBe(SHA);
  });

  it.each([412, 403, 409])('a racing writer (PUT -> %i) with the same size resolves to the ref; a size mismatch rethrows', async (status) => {
    const race = (size: number) => {
      const m = memR2();
      const path = `/adforge-test/${KEY_A}`;
      const f = (async (input: string | URL | Request, init?: RequestInit) => {
        const req = new Request(input, init);
        if (req.method === 'PUT') {
          m.objects.set(path, { bytes: new Uint8Array(size), mime: 'image/png' });
          return new Response('<Error><Code>PreconditionFailed</Code></Error>', { status });
        }
        return m.fetchImpl(req);
      }) as typeof fetch;
      return new R2Storage(CFG, f);
    };
    const ref = await withStorageOrg(ORG_A, () => race(4).put(BYTES, { mime: 'image/png' }));
    expect(ref.id).toBe(KEY_A);
    await expect(withStorageOrg(ORG_A, () => race(9).put(BYTES, { mime: 'image/png' }))).rejects.toBeInstanceOf(ProviderError);
  });

  it('head returns null on 404; read of a missing key throws', async () => {
    const r2 = new R2Storage(CFG, memR2().fetchImpl);
    expect(await r2.head(KEY_A)).toBeNull();
    await expect(r2.read(KEY_A)).rejects.toBeInstanceOf(ProviderError);
  });

  it('an invalid key throws before any request', async () => {
    const m = memR2();
    const r2 = new R2Storage(CFG, m.fetchImpl);
    for (const bad of ['org/../../x', 'a\\b', '../etc/passwd']) {
      await expect(r2.head(bad)).rejects.toThrow(/not a storage key/);
      await expect(r2.read(bad)).rejects.toThrow(/not a storage key/);
      await expect(r2.presignGet(bad, 60)).rejects.toThrow(/not a storage key/);
      await expect(r2.presignPut(bad, { mime: 'image/png', bytes: 1, ttlSec: 60 })).rejects.toThrow(/not a storage key/);
    }
    expect(() => r2.urlFor('../x')).toThrow(/not a storage key/);
    expect(m.calls).toHaveLength(0);
  });
});

describe('live fixture', () => {
  it('the recorded HEAD parses through the same mapping', () => {
    const f = JSON.parse(readFileSync(here('./fixtures/head.live.json'), 'utf8')) as { status: number; headers: Record<string, string> };
    const h = headFromResponse(f.status, new Headers(f.headers));
    expect(h).toEqual({ bytes: expect.any(Number), mime: 'image/png' });
  });
});
