import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { LocalDiskStorage } from '@adforge/provider-local-storage';
import { localPutHandler, mintUploadHandler, type UploadsCtx } from '../lib/server/uploads-api';
import { createJob } from '../lib/api';

const SITE = 'http://w';
const ORG = randomUUID();
const user = { userId: 'u', email: 'e', isAdmin: false, orgId: ORG };
const SHA = 'ab'.repeat(32);
const mint = (body: unknown, origin: string | null = SITE) =>
  new Request('http://w/api/uploads', { method: 'POST', body: JSON.stringify(body), ...(origin ? { headers: { origin } } : {}) });
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

const r2Store = (existing = new Set<string>()) => ({
  head: async (k: string) => (existing.has(k) ? { bytes: 5, mime: 'image/png' } : null),
  presignPut: async (k: string, o: { mime: string; bytes: number; ttlSec: number }) => ({ url: `https://r2.test/${k}?ttl=${o.ttlSec}`, headers: { 'content-type': o.mime } }),
});
const ctxR2 = (over: Partial<UploadsCtx> = {}): UploadsCtx => ({ siteUrl: SITE, auth: async () => user, r2: true, store: r2Store(), ...over });
const dev = () => new LocalDiskStorage(join(mkdtempSync(join(tmpdir(), 'adforge-up-')), 'media'), 'http://pub');
const ctxDev = (store = dev(), over: Partial<UploadsCtx> = {}): UploadsCtx => ({ siteUrl: SITE, auth: async () => user, r2: false, store, ...over });

describe('POST /api/uploads', () => {
  it('401 without a session; 403 cross-origin or no Origin', async () => {
    const no = ctxR2({ auth: async () => Response.json({ error: 'unauthenticated' }, { status: 401 }) });
    expect((await mintUploadHandler(no, mint({}))).status).toBe(401);
    for (const o of ['http://evil.example', null]) expect((await mintUploadHandler(ctxR2(), mint({ mime: 'image/png', bytes: 5, sha256: SHA }, o))).status).toBe(403);
  });
  it('HEIC -> 400 with the export hint', async () => {
    const r = await mintUploadHandler(ctxR2(), mint({ mime: 'image/heic', bytes: 5, sha256: SHA }));
    expect([r.status, await r.json()]).toEqual([400, { error: "HEIC isn't supported yet — export the photo as JPEG" }]);
  });
  it('a body over 1 KB (declared or chunked) -> 413', async () => {
    const big = JSON.stringify({ mime: 'image/png', bytes: 5, sha256: SHA, pad: 'x'.repeat(2000) });
    expect((await mintUploadHandler(ctxR2(), mint(JSON.parse(big)))).status).toBe(413);
    const chunked = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(big)); c.close(); } });
    expect((await mintUploadHandler(ctxR2(), new Request('http://w/api/uploads', { method: 'POST', body: chunked, headers: { origin: SITE }, duplex: 'half' } as RequestInit))).status).toBe(413);
  });
  it('40 MB PNG -> 413', async () => {
    const r = await mintUploadHandler(ctxR2(), mint({ mime: 'image/png', bytes: 41943040, sha256: SHA }));
    expect([r.status, await r.json()]).toEqual([413, { error: 'photo larger than 10 MB' }]);
  });
  it('bad sha256, bad bytes, other mime, junk body -> 400', async () => {
    for (const b of [{ mime: 'image/png', bytes: 5, sha256: 'xyz' }, { mime: 'image/png', bytes: 5, sha256: SHA.toUpperCase() }, { mime: 'image/png', bytes: 0, sha256: SHA }, { mime: 'image/gif', bytes: 5, sha256: SHA }, 'nope'])
      expect((await mintUploadHandler(ctxR2(), mint(b))).status).toBe(400);
    expect((await mintUploadHandler(ctxR2(), new Request('http://w/api/uploads', { method: 'POST', body: '{', headers: { origin: SITE } }))).status).toBe(400);
  });
  it('r2 store: key is under the caller org, url + headers are signed for 300 s', async () => {
    const r = await mintUploadHandler(ctxR2(), mint({ mime: 'image/jpeg', bytes: 5, sha256: SHA }));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ key: `org/${ORG}/ab/${SHA}.jpg`, url: `https://r2.test/org/${ORG}/ab/${SHA}.jpg?ttl=300`, headers: { 'content-type': 'image/jpeg' }, exists: false });
  });
  it('already stored -> exists:true, no url', async () => {
    const key = `org/${ORG}/ab/${SHA}.png`;
    const r = await mintUploadHandler(ctxR2({ store: r2Store(new Set([key])) }), mint({ mime: 'image/png', bytes: 5, sha256: SHA }));
    expect(await r.json()).toEqual({ key, exists: true });
  });
  it('dev store: unprefixed key and a same-origin local url', async () => {
    const b = await (await mintUploadHandler(ctxDev(), mint({ mime: 'image/png', bytes: 5, sha256: SHA }))).json();
    expect(b).toEqual({ key: `ab/${SHA}.png`, url: `/api/uploads/local/ab/${SHA}.png`, headers: { 'content-type': 'image/png' }, exists: false });
  });
});

describe('PUT /api/uploads/local/[...key]', () => {
  const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
  const put = (body: Uint8Array, origin: string | null = SITE, type = 'image/png') =>
    new Request('http://w/api/uploads/local/x', { method: 'PUT', body: new Blob([body as BlobPart]), headers: { 'content-type': type, ...(origin ? { origin } : {}) } });
  const h = sha(PNG);
  const k = [h.slice(0, 2), `${h}.png`];

  it('writes when the body hash matches the key', async () => {
    const store = dev();
    expect((await localPutHandler(ctxDev(store), put(PNG), k)).status).toBe(200);
    expect(await store.head(k.join('/'))).toEqual({ bytes: PNG.byteLength, mime: 'image/png' });
  });
  it('body sha != key sha -> 400, nothing written', async () => {
    const store = dev();
    expect((await localPutHandler(ctxDev(store), put(PNG), ['ab', `${SHA}.png`])).status).toBe(400);
    expect(await store.head(`ab/${SHA}.png`)).toBeNull();
  });
  it('a chunked (no Content-Length) body over the cap -> 413, nothing written', async () => {
    const store = dev();
    const big = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(11 * 1024 * 1024)); c.close(); } });
    const r = await localPutHandler(ctxDev(store), new Request('http://w/x', { method: 'PUT', body: big, headers: { origin: SITE }, duplex: 'half' } as RequestInit), k);
    expect(r.status).toBe(413);
    expect(await store.head(k.join('/'))).toBeNull();
  });
  it('r2 profile -> 404; cross-origin -> 403; no session -> 401; oversize -> 413; non-dev key -> 400', async () => {
    expect((await localPutHandler(ctxDev(dev(), { r2: true }), put(PNG), k)).status).toBe(404);
    expect((await localPutHandler(ctxDev(), put(PNG, 'http://evil.example'), k)).status).toBe(403);
    expect((await localPutHandler(ctxDev(dev(), { auth: async () => Response.json({}, { status: 401 }) }), put(PNG), k)).status).toBe(401);
    expect((await localPutHandler(ctxDev(), new Request('http://w/x', { method: 'PUT', body: new Blob([PNG as BlobPart]), headers: { origin: SITE, 'content-length': String(11 * 1024 * 1024) } }), k)).status).toBe(413);
    expect((await localPutHandler(ctxDev(), put(PNG), ['..', 'x'])).status).toBe(400);
    const odd = await localPutHandler(ctxDev(), put(PNG), [h.slice(0, 2), `${h}.constructor`]);
    expect([odd.status, await odd.json()]).toEqual([400, { error: 'unsupported type .constructor' }]);
    expect((await localPutHandler(ctxDev(), put(PNG), ['org', ORG, h.slice(0, 2), `${h}.png`])).status).toBe(400);
  });
});

describe('api.ts client', () => {
  it('a storage PUT that times out -> "upload timed out", no job posted', async () => {
    const f = new FormData();
    f.append('photos', new File([new Uint8Array([137, 80, 78, 71, 9])], 'p.png', { type: 'image/png' }));
    const urls: string[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      urls.push(url);
      if (url === '/api/uploads') return json({ key: `ab/${JSON.parse(String(init!.body)).sha256}.png`, url: 'https://r2.test/put', headers: {}, exists: false });
      throw new DOMException('timed out', 'TimeoutError');
    }) as typeof fetch;
    expect(await createJob(f, fetchImpl)).toEqual({ ok: false, error: 'photo 1: upload timed out' });
    expect(urls).toEqual(['/api/uploads', 'https://r2.test/put']);
  });
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
  it('403 with the not-invited body -> /waitlist; any other 403 is surfaced, no redirect', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { assign });
    try {
      await createJob(new FormData(), (async () => json({ error: 'not invited' }, 403)) as typeof fetch);
      expect(assign).toHaveBeenCalledWith('/waitlist');
      assign.mockClear();
      const r = await createJob(new FormData(), (async () => json({ error: 'photo key belongs to another account' }, 403)) as typeof fetch);
      expect(assign).not.toHaveBeenCalled();
      expect(r).toEqual({ ok: false, error: 'photo key belongs to another account' });
    } finally { vi.unstubAllGlobals(); }
  });
  it('hashes each photo, mints, PUTs exactly the returned headers (skips when exists), then posts JSON', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const bytes = [1, 2, 3].map((i) => new Uint8Array([137, 80, 78, 71, i]));
    const f = new FormData();
    for (const [key, v] of Object.entries({ name: 'S', price: '1', description: 'd', language: 'en' })) f.append(key, v);
    f.append('broll', 'on');
    for (const b of bytes) f.append('photos', new File([b], 'p.png', { type: 'image/png' }));
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url === '/api/uploads') {
        const { sha256 } = JSON.parse(String(init!.body));
        return json(sha256 === sha(bytes[0]!) ? { key: `ab/${sha256}.png`, exists: true } : { key: `ab/${sha256}.png`, url: 'https://r2.test/put', headers: { 'content-type': 'image/png' }, exists: false });
      }
      if (url === '/api/jobs') return json({ jobId: 'j1' }, 202);
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    expect(await createJob(f, fetchImpl)).toEqual({ ok: true, jobId: 'j1' });
    expect(calls.map((c) => c.url)).toEqual(['/api/uploads', '/api/uploads', 'https://r2.test/put', '/api/uploads', 'https://r2.test/put', '/api/jobs']);
    expect(calls[2]!.init).toMatchObject({ method: 'PUT', headers: { 'content-type': 'image/png' } });
    const jobBody = JSON.parse(String(calls[5]!.init!.body));
    expect(jobBody).toMatchObject({ name: 'S', language: 'en', broll: true });
    expect(jobBody.photoKeys).toHaveLength(3);
  });
  it('a 412 on the storage PUT means already uploaded: the job still posts; other failures stop', async () => {
    const mk = (putStatus: number) => {
      const f = new FormData();
      for (const [key, v] of Object.entries({ name: 'S', price: '1', description: 'd', language: 'en' })) f.append(key, v);
      f.append('photos', new File([new Uint8Array([137, 80, 78, 71, 9])], 'p.png', { type: 'image/png' }));
      const fetchImpl = (async (url: string, init?: RequestInit) => {
        if (url === '/api/uploads') return json({ key: `ab/${JSON.parse(String(init!.body)).sha256}.png`, url: 'https://r2.test/put', headers: {}, exists: false });
        if (url === '/api/jobs') return json({ jobId: 'j1' }, 202);
        return new Response(null, { status: putStatus });
      }) as typeof fetch;
      return createJob(f, fetchImpl);
    };
    expect(await mk(412)).toEqual({ ok: true, jobId: 'j1' });
    expect(await mk(403)).toEqual({ ok: false, error: 'photo 1: upload failed (HTTP 403)' });
  });
});
