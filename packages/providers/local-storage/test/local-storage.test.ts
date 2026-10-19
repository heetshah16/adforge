import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalDiskStorage } from '../src/index';

let root: string;
let storage: LocalDiskStorage;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'adforge-media-'));
  storage = new LocalDiskStorage(root, 'http://localhost:3000');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const bytes = new TextEncoder().encode('fake png bytes');

describe('LocalDiskStorage', () => {
  it('stores content-addressed and returns an internal MediaRef', async () => {
    const ref = await storage.put(bytes, { mime: 'image/png', width: 10, height: 20 });
    expect(ref.id).toMatch(/^[0-9a-f]{2}\/[0-9a-f]{64}\.png$/);
    expect(ref.url).toBe(`http://localhost:3000/media/${ref.id}`);
    expect(ref).toMatchObject({ mime: 'image/png', bytes: bytes.byteLength, width: 10, height: 20 });
    expect(ref.sha256).toBe(ref.id.slice(3, 67));
  });

  it('dedupes identical bytes to one file', async () => {
    const a = await storage.put(bytes, { mime: 'image/png' });
    const b = await storage.put(bytes, { mime: 'image/png' });
    expect(b.id).toBe(a.id);
    const shard = a.id.slice(0, 2);
    expect(readdirSync(join(root, shard))).toEqual([a.id.slice(3)]); // no leftover temp files
  });

  it('round-trips through read', async () => {
    const ref = await storage.put(bytes, { mime: 'audio/wav' });
    expect(Buffer.from(await storage.read(ref.id)).toString()).toBe('fake png bytes');
  });

  it('rejects keys that are not content-addressed (path traversal)', async () => {
    await expect(storage.read('../../etc/passwd')).rejects.toThrow(/Invalid storage key/);
    await expect(storage.read('ab/../../x.png')).rejects.toThrow(/Invalid storage key/);
  });

  it('urlFor builds the internal media URL for a key', () => {
    const key = `ab/${'a'.repeat(64)}.png`;
    expect(storage.urlFor(key)).toBe(`http://localhost:3000/media/${key}`);
  });

  it('rejects unknown mime types', async () => {
    await expect(storage.put(bytes, { mime: 'application/x-msdownload' })).rejects.toThrow(/Unsupported mime/);
  });
});

describe('LocalDiskStorage.head', () => {
  it('returns { bytes, mime } for a stored key and null for a missing one', async () => {
    const ref = await storage.put(bytes, { mime: 'image/png' });
    expect(await storage.head(ref.id)).toEqual({ bytes: bytes.byteLength, mime: 'image/png' });
    expect(await storage.head(`00/${'0'.repeat(64)}.png`)).toBeNull();
  });
});
