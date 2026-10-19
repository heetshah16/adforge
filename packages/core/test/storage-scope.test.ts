import { describe, expect, it } from 'vitest';
import { MIME_EXT, devKey, orgKey, orgOfKey, parseKey } from '../src/providers/storage-key';
import { storageOrg, withStorageOrg } from '../src/providers/storage-scope';
import { StorageKey } from '../src/spec/video-spec';

const ORG_A = '0a1b2c3d-0000-4000-8000-00000000000a';
const ORG_B = '0a1b2c3d-0000-4000-8000-00000000000b';
const sha = 'ab' + 'c'.repeat(62);

describe('storage scope', () => {
  it('orgKey builds the tenant layout and orgOfKey inverts it', () => {
    expect(orgKey(ORG_A, sha, 'png')).toBe(`org/${ORG_A}/ab/${sha}.png`);
    expect(orgOfKey(`org/${ORG_A}/ab/${sha}.png`)).toBe(ORG_A);
    expect(orgOfKey(`ab/${sha}.png`)).toBeNull();
  });

  it('devKey shards by the first two hex chars of the sha', () => {
    expect(devKey(sha, 'png')).toBe(`ab/${sha}.png`);
  });

  it('orgKey and orgOfKey refuse anything that is not a storage key', () => {
    expect(() => orgKey('not-a-uuid', sha, 'png')).toThrow(/storage key/);
    expect(() => orgKey(ORG_A, 'zz', 'png')).toThrow(/storage key/);
    expect(() => orgOfKey(`org/../ab/${sha}.png`)).toThrow(/storage key/);
  });

  it('StorageKey accepts dev and org keys, rejects traversal and bad uuids', () => {
    expect(StorageKey.safeParse(`ab/${sha}.png`).success).toBe(true);
    expect(StorageKey.safeParse(`org/${ORG_A}/ab/${sha}.png`).success).toBe(true);
    for (const k of [`org/../ab/${sha}.png`, `org/not-a-uuid/ab/${sha}.png`, `org/${ORG_A}\\ab\\${sha}.png`, `org/${ORG_A.toUpperCase()}/ab/${sha}.png`])
      expect(StorageKey.safeParse(k).success).toBe(false);
  });

  it('concurrent scopes do not leak into each other', async () => {
    const seen = await Promise.all([ORG_A, ORG_B].map((o) => withStorageOrg(o, async () => { await new Promise((r) => setTimeout(r, 5)); return storageOrg(); })));
    expect(seen).toEqual([ORG_A, ORG_B]);
    expect(storageOrg()).toBeUndefined();
  });

  it('re-entering a different org throws; the same org is allowed', async () => {
    await withStorageOrg(ORG_A, () => withStorageOrg(ORG_A, async () => 1));
    await expect(withStorageOrg(ORG_A, () => withStorageOrg(ORG_B, async () => 1))).rejects.toThrow(/storage org scope/);
  });

  it('rejects a scope id that is not a lowercase uuid', async () => {
    await expect(withStorageOrg(ORG_A.toUpperCase(), async () => 1)).rejects.toThrow(/storage org scope/);
    await expect(withStorageOrg('', async () => 1)).rejects.toThrow(/storage org scope/);
  });

  it('MIME_EXT is frozen and covers the stored media types', () => {
    expect(MIME_EXT['image/jpeg']).toBe('jpg');
    expect(Object.isFrozen(MIME_EXT)).toBe(true);
  });
});

describe('parseKey', () => {
  const sha = 'ab'.repeat(32);
  const org = '11111111-2222-4333-8444-555555555555';
  it('splits org, sha and ext; null org for dev keys', () => {
    expect(parseKey(`org/${org}/ab/${sha}.png`)).toEqual({ org, sha, ext: 'png' });
    expect(parseKey(`ab/${sha}.jpg`)).toEqual({ org: null, sha, ext: 'jpg' });
  });
  it('null for anything that is not a storage key', () => {
    for (const k of ['', '../x', `org/../../ab/${sha}.png`, `ab/${sha}`, 'x/y.png']) expect(parseKey(k)).toBeNull();
  });
});
