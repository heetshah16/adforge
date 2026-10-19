import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MediaRef, PutOptions, StorageProvider } from '@adforge/core/providers/types';
import { CachedStorage } from '../src/cached';

const KEY = `ab/${'a'.repeat(64)}.png`;
const CACHE_FILE = (dir: string) => join(dir, 'ab', `${'a'.repeat(64)}.png`);
const BYTES = new TextEncoder().encode('fake png bytes');

/** In-memory inner store: counts calls so tests can tell a cache hit from a miss. */
class MemStore implements StorageProvider {
  readonly id = 'mem';
  readonly files = new Map<string, Uint8Array>();
  readonly reads: string[] = [];
  puts = 0;
  /** The key the next put stores under. */
  nextKey = KEY;

  async put(bytes: Uint8Array, opts: PutOptions): Promise<MediaRef> {
    this.puts++;
    this.files.set(this.nextKey, bytes);
    return { id: this.nextKey, url: this.urlFor(this.nextKey), mime: opts.mime, sha256: 'a'.repeat(64), bytes: bytes.byteLength };
  }
  async read(key: string): Promise<Uint8Array> {
    this.reads.push(key);
    const b = this.files.get(key);
    if (!b) throw new Error(`missing ${key}`);
    return b;
  }
  urlFor(key: string): string {
    return `http://mem/media/${key}`;
  }
}

let root: string;
let dir: string;
let inner: MemStore;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'adforge-cached-'));
  dir = join(root, 'cache');
  inner = new MemStore();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('CachedStorage', () => {
  it('a cache hit does not call inner.read', async () => {
    inner.files.set(KEY, BYTES);
    const cs = new CachedStorage(inner, dir);
    await cs.read(KEY); // miss: fills the cache
    expect(Buffer.from(await cs.read(KEY))).toEqual(Buffer.from(BYTES)); // hit
    expect(inner.reads).toEqual([KEY]);
    // A fresh instance over the same dir also hits: the cache is on disk, not in memory.
    expect(Buffer.from(await new CachedStorage(new MemStore(), dir).read(KEY))).toEqual(Buffer.from(BYTES));
  });

  it('a miss calls inner.read once and fills the cache', async () => {
    inner.files.set(KEY, BYTES);
    const cs = new CachedStorage(inner, dir);
    expect(Buffer.from(await cs.read(KEY))).toEqual(Buffer.from(BYTES));
    expect(inner.reads).toEqual([KEY]);
    expect(readFileSync(CACHE_FILE(dir))).toEqual(Buffer.from(BYTES));
  });

  it('a miss that inner.read rejects propagates the error and caches nothing', async () => {
    const cs = new CachedStorage(inner, dir);
    await expect(cs.read(KEY)).rejects.toThrow(/missing/);
    expect(existsSync(CACHE_FILE(dir))).toBe(false);
  });

  it('put persists to inner and to the cache dir', async () => {
    const cs = new CachedStorage(inner, dir);
    const ref = await cs.put(BYTES, { mime: 'image/png' });
    expect(ref.id).toBe(KEY);
    expect(inner.puts).toBe(1);
    expect(readFileSync(CACHE_FILE(dir))).toEqual(Buffer.from(BYTES));
    // Served from the cache: no inner read needed.
    expect(Buffer.from(await cs.read(KEY))).toEqual(Buffer.from(BYTES));
    expect(inner.reads).toEqual([]);
  });

  it('keys failing STORAGE_KEY_RE throw before any fs access', async () => {
    const cs = new CachedStorage(inner, dir);
    for (const bad of ['org/../x', 'ab\\..\\x', '../etc/passwd', 'AB/' + 'a'.repeat(64) + '.png', 'ab/x.png']) {
      await expect(cs.read(bad)).rejects.toThrow(/Invalid storage key/);
    }
    expect(inner.reads).toEqual([]);
    expect(existsSync(dir)).toBe(false);
  });

  it('parallel reads on a cold cache both resolve to the same bytes', async () => {
    inner.files.set(KEY, BYTES);
    const cs = new CachedStorage(inner, dir);
    const [a, b] = await Promise.all([cs.read(KEY), cs.read(KEY)]);
    expect(Buffer.from(a)).toEqual(Buffer.from(BYTES));
    expect(Buffer.from(b)).toEqual(Buffer.from(BYTES));
    expect(readFileSync(CACHE_FILE(dir))).toEqual(Buffer.from(BYTES));
  });

  it('a failing cache fill does not fail read or put', async () => {
    // The cache dir is a FILE, so mkdir/readFile under it fail.
    writeFileSync(dir, 'not a dir');
    inner.files.set(KEY, BYTES);
    const cs = new CachedStorage(inner, dir);
    expect(Buffer.from(await cs.read(KEY))).toEqual(Buffer.from(BYTES));
    const ref = await cs.put(BYTES, { mime: 'image/png' });
    expect(ref.id).toBe(KEY);
  });

  it('a failed rename leaves no .tmp file behind and the read still succeeds', async () => {
    // A directory at the target makes rename(tmp, target) fail.
    mkdirSync(CACHE_FILE(dir), { recursive: true });
    inner.files.set(KEY, BYTES);
    const cs = new CachedStorage(inner, dir);
    expect(Buffer.from(await cs.read(KEY))).toEqual(Buffer.from(BYTES));
    expect(readdirSync(join(dir, 'ab')).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('an org key reads and writes under <dir>/org/<uuid>/ab/<sha>.png', async () => {
    const uuid = '0123abcd-0123-4abc-8def-0123456789ab';
    const orgKey = `org/${uuid}/ab/${'a'.repeat(64)}.png`;
    const orgPath = join(dir, 'org', uuid, 'ab', `${'a'.repeat(64)}.png`);
    inner.files.set(orgKey, BYTES);
    const cs = new CachedStorage(inner, dir);
    expect(Buffer.from(await cs.read(orgKey))).toEqual(Buffer.from(BYTES));
    expect(readFileSync(orgPath)).toEqual(Buffer.from(BYTES));
    // put writes the cache under the org key the inner store returns.
    rmSync(orgPath);
    inner.nextKey = orgKey;
    await cs.put(BYTES, { mime: 'image/png' });
    expect(readFileSync(orgPath)).toEqual(Buffer.from(BYTES));
  });

  it('id is cached:<inner id>, urlFor delegates to inner', () => {
    const cs = new CachedStorage(inner, dir);
    expect(cs.id).toBe('cached:mem');
    expect(cs.urlFor(KEY)).toBe(inner.urlFor(KEY));
  });
});
