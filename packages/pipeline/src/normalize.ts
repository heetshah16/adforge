import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { parseKey } from '@adforge/core/providers/storage-key';
import { storageOrg } from '@adforge/core/providers/storage-scope';
import type { MediaRef, StorageProvider } from '@adforge/core/providers/types';
import { MAX_PHOTO } from './job-input';

export type Normalized =
  | { ok: true; bytes: Uint8Array; mime: 'image/png' | 'image/jpeg'; width: number; height: number }
  | { ok: false; error: string };

const MAX_SIDE = 8192;
const MAX_PIXELS = 50_000_000;
const at = (b: Uint8Array, o: number, s: string) => s.length + o <= b.length && [...s].every((c, i) => b[o + i] === c.charCodeAt(0));
const sniff = (b: Uint8Array) =>
  b[0] === 0x89 && at(b, 1, 'PNG') ? 'png' : b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff ? 'jpeg' : at(b, 0, 'RIFF') && at(b, 8, 'WEBP') ? 'webp' : null;

/** Decodes and re-encodes an uploaded photo: sRGB, EXIF orientation applied, all metadata dropped. PNG stays PNG; JPEG/WebP become JPEG q92. */
export async function normalizeImage(bytes: Uint8Array): Promise<Normalized> {
  const kind = sniff(bytes);
  if (!kind) {
    if (at(bytes, 4, 'ftyp') && ['heic', 'heix', 'mif1'].includes(String.fromCharCode(...bytes.subarray(8, 12)))) return { ok: false, error: "HEIC isn't supported yet — export the photo as JPEG" };
    return { ok: false, error: 'could not read this image' };
  }
  try {
    const opts = { limitInputPixels: MAX_PIXELS, failOn: 'error' as const };
    const meta = await sharp(bytes, { failOn: 'error' }).metadata(); // header only; the pixel limit applies to the decode below
    const [w, h] = [meta.width ?? 0, meta.height ?? 0];
    if (w > MAX_SIDE || h > MAX_SIDE) return { ok: false, error: 'photo larger than 8192 px' };
    if (w * h > MAX_PIXELS) return { ok: false, error: 'photo larger than 50 megapixels' };
    const img = sharp(bytes, opts).rotate().toColorspace('srgb');
    const { data, info } = await (kind === 'png' ? img.png() : img.flatten({ background: '#ffffff' }).jpeg({ quality: 92 })).toBuffer({ resolveWithObject: true });
    return { ok: true, bytes: new Uint8Array(data), mime: kind === 'png' ? 'image/png' : 'image/jpeg', width: info.width, height: info.height };
  } catch {
    return { ok: false, error: 'could not read this image' };
  }
}

export class Rejected extends Error {}

/**
 * Reads an uploaded photo back from storage, checks the bytes still hash to the sha in their key (a presigned browser PUT body is unsigned),
 * then normalizes and stores the result. `n` is the 1-based photo number used in messages. Throws `Rejected` on a bad photo.
 */
export async function normalizeStored(storage: StorageProvider, key: string, n: number): Promise<MediaRef> {
  const parsed = parseKey(key);
  if (!parsed) throw new Rejected(`photo ${n}: not a storage key`);
  if (parsed.org !== null && parsed.org !== storageOrg()) throw new Rejected(`photo ${n} belongs to another account`);
  const bytes = await storage.read(key);
  if (bytes.length > MAX_PHOTO) throw new Rejected(`photo ${n} is larger than 10 MB`);
  if (createHash('sha256').update(bytes).digest('hex') !== parsed.sha) throw new Rejected(`photo ${n} is corrupted — upload it again`);
  const r = await normalizeImage(bytes);
  if (!r.ok) throw new Rejected(`photo ${n}: ${r.error}`);
  return storage.put(r.bytes, { mime: r.mime, width: r.width, height: r.height });
}
