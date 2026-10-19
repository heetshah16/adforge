import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { LocalDiskStorage } from '@adforge/provider-local-storage';
import { normalizeImage, normalizeStored } from '../src/normalize';

const base = (w = 40, h = 20) => sharp({ create: { width: w, height: h, channels: 3, background: '#c33' } });
const ok = async (b: Uint8Array) => { const r = await normalizeImage(b); if (!r.ok) throw new Error(r.error); return r; };

describe('normalizeImage', () => {
  it('CMYK JPEG → sRGB', async () => {
    const r = await ok(await base().toColorspace('cmyk').jpeg().toBuffer());
    expect((await sharp(r.bytes).metadata()).space).toBe('srgb');
  });
  it('EXIF (GPS) is stripped', async () => {
    const src = await base().jpeg().withExif({ IFD0: { Copyright: 'me' }, IFD3: { GPSLatitudeRef: 'N' } }).toBuffer();
    expect((await sharp(src).metadata()).exif).toBeDefined();
    expect((await sharp((await ok(src)).bytes).metadata()).exif).toBeUndefined();
  });
  it('EXIF orientation 6, 40x20 → 20x40', async () => {
    const r = await ok(await base().jpeg().withMetadata({ orientation: 6 }).toBuffer());
    expect([r.width, r.height]).toEqual([20, 40]);
    expect(r.mime).toBe('image/jpeg');
  });
  it('PNG stays PNG; WebP becomes JPEG', async () => {
    expect((await ok(await base().png().toBuffer())).mime).toBe('image/png');
    expect((await ok(await base().webp().toBuffer())).mime).toBe('image/jpeg');
  });
  it('polyglot: appended script payload is gone', async () => {
    const jpg = await base().jpeg().toBuffer();
    const r = await ok(Buffer.concat([jpg, Buffer.from('<script>PK\x03\x04')]));
    expect(Buffer.from(r.bytes).includes('<script>')).toBe(false);
  });
  it('9000x9000 PNG is too large', async () => {
    const png = await sharp({ create: { width: 9000, height: 9000, channels: 3, background: '#fff' } }).png({ compressionLevel: 9 }).toBuffer();
    expect(await normalizeImage(png)).toEqual({ ok: false, error: 'photo larger than 8192 px' });
  });
  it('8192x8192 PNG exceeds the pixel limit with a size message', async () => {
    const png = await sharp({ create: { width: 8192, height: 8192, channels: 3, background: '#fff' } }).png({ compressionLevel: 9 }).toBuffer();
    expect(await normalizeImage(png)).toEqual({ ok: false, error: 'photo larger than 50 megapixels' });
  });
  it('fully transparent WebP → white JPEG', async () => {
    const webp = await sharp({ create: { width: 8, height: 8, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).webp().toBuffer();
    const { data } = await sharp((await ok(webp)).bytes).raw().toBuffer({ resolveWithObject: true });
    expect([...data.subarray(0, 3)].every((v) => v >= 250)).toBe(true);
  });
  it('HEIC magic', async () => {
    const heic = new Uint8Array([0, 0, 0, 24, ...Buffer.from('ftypheic'), 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(await normalizeImage(heic)).toEqual({ ok: false, error: "HEIC isn't supported yet — export the photo as JPEG" });
  });
  it('PNG magic + garbage; truncated JPEG; plain junk', async () => {
    const bad = { ok: false, error: 'could not read this image' };
    expect(await normalizeImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5]))).toEqual(bad);
    const jpg = await base(400, 400).jpeg().toBuffer();
    expect(await normalizeImage(jpg.subarray(0, 200))).toEqual(bad);
    expect(await normalizeImage(new Uint8Array([1, 2, 3]))).toEqual(bad);
  });
});

describe('normalizeStored', () => {
  const store = () => new LocalDiskStorage(join(mkdtempSync(join(tmpdir(), 'adforge-norm-')), 'media'), 'http://localhost:3000');
  it('re-encodes and stores under the new sha', async () => {
    const s = store();
    const src = await s.put(await base().jpeg().withExif({ IFD0: { Copyright: 'me' } }).toBuffer(), { mime: 'image/jpeg' });
    const ref = await normalizeStored(s, src.id, 1);
    expect(ref.sha256).not.toBe(src.sha256);
    expect(ref.sha256).toBe(createHash('sha256').update(await s.read(ref.id)).digest('hex'));
    expect([ref.width, ref.height]).toEqual([40, 20]);
  });
  it('over 10 MB is rejected before hashing or decoding', async () => {
    const s = store();
    const big = await s.put(new Uint8Array(11 * 1024 * 1024), { mime: 'image/png' });
    await expect(normalizeStored(s, big.id, 3)).rejects.toThrow('photo 3 is larger than 10 MB');
  });
  it('bytes that do not hash to the key sha are rejected before decoding', async () => {
    const s = store();
    const good = await s.put(await base().jpeg().toBuffer(), { mime: 'image/jpeg' });
    const other = await s.put(await base(10, 10).jpeg().toBuffer(), { mime: 'image/jpeg' });
    // Simulate a swapped body behind an honest key.
    const lie = { ...s, read: async (k: string) => s.read(k === good.id ? other.id : k) } as unknown as LocalDiskStorage;
    await expect(normalizeStored(lie, good.id, 2)).rejects.toThrow('photo 2 is corrupted — upload it again');
  });
});
