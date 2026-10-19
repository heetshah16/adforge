import { createHash } from 'node:crypto';
import { z } from 'zod';
import { MIME_EXT, orgKey, parseKey } from '@adforge/core/providers/storage-key';
import { MAX_PHOTO, PHOTO_TYPES } from '@adforge/pipeline/job-input';
import { isSiteOrigin } from './origin';
import { readBytesCapped } from './read-capped';
import type { SessionUser } from './session';

/** What the upload routes need from the media store. R2 presigns; local disk is written through our own PUT route. */
export type UploadStore = {
  head(key: string): Promise<{ bytes: number; mime: string } | null>;
  presignPut?(key: string, o: { mime: string; bytes: number; ttlSec: number }): Promise<{ url: string; headers: Record<string, string> }>;
  put?(bytes: Uint8Array, o: { mime: string }): Promise<unknown>;
};
export type UploadsCtx = {
  auth(): Promise<SessionUser | Response>;
  siteUrl: string;
  /** true: R2 store, org-prefixed keys, presigned PUT. false: local disk, unprefixed keys, dev PUT route. */
  r2: boolean;
  store: UploadStore;
};

export const PRESIGN_TTL_SEC = 300;
const json = (body: unknown, status = 200) => Response.json(body, { status });
const MIME_BY_EXT: Record<string, string> = Object.assign(Object.create(null), Object.fromEntries(Object.entries(MIME_EXT).map(([m, e]) => [e, m])));
const Mint = z.object({ mime: z.string(), bytes: z.number().int().positive(), sha256: z.string().regex(/^[0-9a-f]{64}$/, 'sha256 must be 64 lowercase hex chars') });

/** Rejects what mint and the dev PUT both refuse, by type then size. Null = acceptable. */
export function photoProblem(mime: string, bytes: number): Response | null {
  if (mime === 'image/heic' || mime === 'image/heif') return json({ error: "HEIC isn't supported yet — export the photo as JPEG" }, 400);
  if (!PHOTO_TYPES.includes(mime)) return json({ error: `unsupported type ${mime || 'unknown'} (png, jpeg, webp only)` }, 400);
  if (bytes > MAX_PHOTO) return json({ error: 'photo larger than 10 MB' }, 413);
  return null;
}

/** POST /api/uploads: mints the key for a photo the browser is about to upload. Never touches the bytes. */
export async function mintUploadHandler(ctx: UploadsCtx, req: Request): Promise<Response> {
  const user = await ctx.auth();
  if (user instanceof Response) return user;
  if (!isSiteOrigin(req, ctx.siteUrl)) return json({ error: 'forbidden' }, 403);
  const raw = await req.json().catch(() => null);
  const mimeOnly = z.object({ mime: z.string(), bytes: z.number() }).safeParse(raw);
  // Type and size first so HEIC and 40 MB files get their specific messages.
  if (mimeOnly.success) {
    const p = photoProblem(mimeOnly.data.mime, mimeOnly.data.bytes);
    if (p) return p;
  }
  const body = Mint.safeParse(raw);
  if (!body.success) return json({ error: 'invalid upload request', issues: z.flattenError(body.error).fieldErrors }, 400);
  const { mime, bytes, sha256 } = body.data;
  const ext = MIME_EXT[mime]!;
  const key = ctx.r2 ? orgKey(user.orgId, sha256, ext) : `${sha256.slice(0, 2)}/${sha256}.${ext}`;
  // Content-addressed and write-once: if it is already there, the browser skips the PUT.
  if (await ctx.store.head(key)) return json({ key, exists: true });
  if (ctx.r2) {
    if (!ctx.store.presignPut) throw new Error('r2 store cannot presign');
    const { url, headers } = await ctx.store.presignPut(key, { mime, bytes, ttlSec: PRESIGN_TTL_SEC });
    return json({ key, url, headers, exists: false });
  }
  return json({ key, url: `/api/uploads/local/${key}`, headers: { 'content-type': mime }, exists: false });
}

/** PUT /api/uploads/local/<key>: dev only stand-in for the presigned R2 PUT. Verifies the bytes hash to the key. */
export async function localPutHandler(ctx: UploadsCtx, req: Request, keyParts: string[]): Promise<Response> {
  if (ctx.r2) return json({ error: 'not found' }, 404);
  const user = await ctx.auth();
  if (user instanceof Response) return user;
  if (!isSiteOrigin(req, ctx.siteUrl)) return json({ error: 'forbidden' }, 403);
  const key = keyParts.join('/');
  const k = parseKey(key);
  if (!k || k.org !== null || key.slice(0, 2) !== k.sha.slice(0, 2)) return json({ error: 'invalid key' }, 400);
  const mime = MIME_BY_EXT[k.ext];
  if (!mime || !PHOTO_TYPES.includes(mime)) return json({ error: `unsupported type .${k.ext}` }, 400);
  if (!ctx.store.put) throw new Error('local store cannot put');
  const bytes = await readBytesCapped(req, MAX_PHOTO);
  if (!bytes) return json({ error: 'photo larger than 10 MB' }, 413);
  if (createHash('sha256').update(bytes).digest('hex') !== k.sha) return json({ error: 'body does not match the key' }, 400);
  await ctx.store.put(bytes, { mime });
  return json({ key });
}
