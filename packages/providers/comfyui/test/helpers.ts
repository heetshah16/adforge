import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { MediaRef, PutOptions, StorageProvider } from '@adforge/core/providers/types';

type Handler = (req: Request) => Response | Promise<Response>;

/** Routes are keyed `METHOD /path` (query ignored). Unrouted calls throw, so tests see every request. */
export function fakeFetch(routes: Record<string, Handler>) {
  const calls: string[] = [];
  const bodies: Record<string, unknown[]> = {};
  const impl = (async (input: string | Request | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const key = `${req.method} ${new URL(req.url).pathname}`;
    calls.push(key);
    if (req.headers.get('content-type')?.includes('application/json')) {
      (bodies[key] ??= []).push(await req.clone().json());
    }
    const handler = routes[key];
    if (!handler) throw new Error(`unrouted request: ${key}`);
    return handler(req);
  }) as typeof fetch;
  return Object.assign(impl, { calls, bodies });
}

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'));

/** A minimal PNG header (signature + IHDR) — enough for dimension parsing. */
export function pngBytes(width: number, height: number): Uint8Array {
  const b = new Uint8Array(33);
  b.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  const v = new DataView(b.buffer);
  v.setUint32(16, width);
  v.setUint32(20, height);
  return b;
}

export function memoryStorage() {
  const files = new Map<string, Uint8Array>();
  const puts: PutOptions[] = [];
  const storage: StorageProvider = {
    id: 'memory',
    async put(bytes, opts) {
      puts.push(opts);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const id = `${sha256.slice(0, 2)}/${sha256}.${opts.mime.split('/')[1]}`;
      files.set(id, bytes);
      const ref: MediaRef = { id, url: `http://localhost:3000/media/${id}`, mime: opts.mime, sha256, bytes: bytes.byteLength };
      return { ...ref, width: opts.width, height: opts.height, durationSec: opts.durationSec };
    },
    async read(key) {
      const b = files.get(key);
      if (!b) throw new Error(`no such key ${key}`);
      return b;
    },
  };
  return Object.assign(storage, { files, puts });
}
