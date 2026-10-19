import { z } from 'zod';
import { Language } from '@adforge/core/vocab/enums';
import { STORAGE_KEY_RE } from '@adforge/core/providers/storage-key';

export const MAX_BODY = 30 * 1024 * 1024;
export const MAX_PHOTO = 10 * 1024 * 1024;
const TYPES = { 'image/png': [0x89, 0x50, 0x4e, 0x47], 'image/jpeg': [0xff, 0xd8, 0xff], 'image/webp': [0x52, 0x49, 0x46, 0x46] } as const;
export type PhotoType = keyof typeof TYPES;
/** The photo mime types accepted anywhere (multipart sniffing here; presigned uploads in apps/web). */
export const PHOTO_TYPES: readonly string[] = Object.keys(TYPES);
const Fields = z.object({
  name: z.string().trim().min(1, 'name is required').max(120),
  price: z.string().trim().min(1, 'price is required').max(40),
  description: z.string().trim().min(1, 'description is required').max(2000),
  /** Optional; the brand the hook must not name. Falls back to a guarded first word of `name` (P5 direct.ts). */
  brand: z.string().trim().max(60).optional(),
  language: Language,
  broll: z.boolean(),
});
export type JobFields = z.infer<typeof Fields>;
export type JobUpload =
  | { ok: true; fields: JobFields; photos: { bytes: Uint8Array; type: PhotoType }[] }
  | { ok: false; status: 400 | 413; error: string; issues?: Record<string, string[] | undefined> };

const sniff = (b: Uint8Array, type: PhotoType) => TYPES[type].every((x, i) => b[i] === x) && (type !== 'image/webp' || String.fromCharCode(...b.slice(8, 12)) === 'WEBP');
const bad = (error: string, issues?: Record<string, string[] | undefined>): JobUpload => ({ ok: false, status: 400, error, ...(issues ? { issues } : {}) });

/**
 * Validates everything before the caller stores anything: a rejected upload leaves no files, assets or job behind.
 * Callers check Content-Length against MAX_BODY first (413 before parsing); `maxBody` also bounds the summed photo sizes.
 */
export async function parseJobUpload(form: FormData, opts: { maxBody?: number } = {}): Promise<JobUpload> {
  const fields = Fields.safeParse({
    name: form.get('name') ?? '', price: form.get('price') ?? '', description: form.get('description') ?? '',
    brand: form.get('brand') || undefined,
    language: form.get('language'), broll: ['on', 'true'].includes(String(form.get('broll') ?? '')),
  });
  if (!fields.success) return bad('invalid fields', z.flattenError(fields.error).fieldErrors);
  const files = form.getAll('photos').filter((p): p is File => p instanceof File);
  if (files.length < 3 || files.length > 5) return bad(`need 3–5 photos, got ${files.length}`);
  if (files.reduce((n, p) => n + p.size, 0) > (opts.maxBody ?? MAX_BODY)) return { ok: false, status: 413, error: 'upload larger than 30 MB' };
  const photos: { bytes: Uint8Array; type: PhotoType }[] = [];
  for (const p of files) {
    if (!Object.hasOwn(TYPES, p.type)) return bad(`${p.name}: unsupported type ${p.type || 'unknown'} (png, jpeg, webp only)`);
    if (p.size > MAX_PHOTO) return bad(`${p.name}: larger than 10 MB`);
    const bytes = new Uint8Array(await p.arrayBuffer());
    if (!sniff(bytes, p.type as PhotoType)) return bad(`${p.name}: not a real ${p.type} file`);
    photos.push({ bytes, type: p.type as PhotoType });
  }
  return { ok: true, fields: fields.data, photos };
}

export type JobRequest =
  | { ok: true; fields: JobFields; photoKeys: string[] }
  | { ok: false; status: 400; error: string; issues?: Record<string, string[] | undefined> };

const Request_ = Fields.extend({ photoKeys: z.array(z.string().regex(STORAGE_KEY_RE, 'not a storage key')).min(3, 'need 3–5 photos').max(5, 'need 3–5 photos') });

/** JSON job create: the photos are already in storage, so this validates fields and key shapes only. Ownership and existence are checked by the caller. */
export function parseJobRequest(body: unknown): JobRequest {
  const r = Request_.safeParse(body);
  if (!r.success) return bad('invalid fields', z.flattenError(r.error).fieldErrors) as JobRequest;
  const { photoKeys, ...fields } = r.data;
  return { ok: true, fields, photoKeys };
}
