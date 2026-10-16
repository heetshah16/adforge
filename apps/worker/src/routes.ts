import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { Language } from '@adforge/core/vocab/enums';
import { assets, jobs, variants } from '@adforge/db/schema';
import type { PipelineDeps } from '@adforge/pipeline';
import { saveAsset } from '@adforge/pipeline/record';
import type { LocalDiskStorage } from '@adforge/provider-local-storage';

const MAX_BODY = 30 * 1024 * 1024;
const MAX_PHOTO = 5 * 1024 * 1024;
const TYPES = { 'image/png': [0x89, 0x50, 0x4e, 0x47], 'image/jpeg': [0xff, 0xd8, 0xff], 'image/webp': [0x52, 0x49, 0x46, 0x46] } as const;
const Fields = z.object({
  name: z.string().trim().min(1, 'name is required').max(120),
  price: z.string().trim().min(1, 'price is required').max(40),
  description: z.string().trim().min(1, 'description is required').max(2000),
  /** Optional; the brand the hook must not name. Falls back to a guarded first word of `name` (P5 direct.ts). */
  brand: z.string().trim().max(60).optional(),
  language: Language,
  broll: z.boolean(),
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const bad = (error: string, issues?: unknown) => json({ error, issues }, 400);
const sniff = (b: Uint8Array, type: keyof typeof TYPES) => TYPES[type].every((x, i) => b[i] === x) && (type !== 'image/webp' || String.fromCharCode(...b.slice(8, 12)) === 'WEBP');

export function makeRoutes(ctx: { deps: PipelineDeps; storage: LocalDiskStorage; sendEvent(name: string, data: unknown): Promise<void> }) {
  const { deps, storage } = ctx;

  return {
    async health() {
      return json({ ok: true });
    },

    async createJob(req: Request): Promise<Response> {
      if (Number(req.headers.get('content-length') ?? 0) > MAX_BODY) return json({ error: 'upload larger than 30 MB' }, 413);
      let form: FormData;
      try { form = await req.formData(); } catch { return bad('expected multipart/form-data'); }
      const fields = Fields.safeParse({
        name: form.get('name') ?? '', price: form.get('price') ?? '', description: form.get('description') ?? '',
        brand: form.get('brand') || undefined,
        language: form.get('language'), broll: ['on', 'true'].includes(String(form.get('broll') ?? '')),
      });
      if (!fields.success) return bad('invalid fields', z.flattenError(fields.error).fieldErrors);
      const photos = form.getAll('photos').filter((p): p is File => p instanceof File);
      if (photos.length < 3 || photos.length > 5) return bad(`need 3–5 photos, got ${photos.length}`);
      // Validate everything before storing anything: a rejected upload leaves no files, assets or job behind.
      const loaded: { bytes: Uint8Array; type: keyof typeof TYPES }[] = [];
      for (const p of photos) {
        if (!Object.hasOwn(TYPES, p.type)) return bad(`${p.name}: unsupported type ${p.type || 'unknown'} (png, jpeg, webp only)`);
        if (p.size > MAX_PHOTO) return bad(`${p.name}: larger than 5 MB`);
        const bytes = new Uint8Array(await p.arrayBuffer());
        if (!sniff(bytes, p.type as keyof typeof TYPES)) return bad(`${p.name}: not a real ${p.type} file`);
        loaded.push({ bytes, type: p.type as keyof typeof TYPES });
      }
      const photoKeys: string[] = [];
      for (const { bytes, type } of loaded) {
        const ref = await storage.put(bytes, { mime: type });
        await saveAsset(deps.db, deps.projectId, 'upload', ref);
        photoKeys.push(ref.id);
      }
      const f = fields.data;
      const [job] = await deps.db.insert(jobs).values({
        projectId: deps.projectId, userId: deps.userId,
        inputSpec: { product: { name: f.name, price: f.price, description: f.description, ...(f.brand ? { brand: f.brand } : {}) }, language: f.language, broll: f.broll, photoKeys },
      }).returning();
      await ctx.sendEvent('adforge/job.requested', { jobId: job!.id });
      return json({ jobId: job!.id }, 202);
    },

    async getJob(req: Request): Promise<Response> {
      const id = new URL(req.url).pathname.split('/').pop() ?? '';
      if (!z.uuid().safeParse(id).success) return json({ error: 'not found' }, 404);
      const [j] = await deps.db.select().from(jobs).where(eq(jobs.id, id));
      if (!j) return json({ error: 'not found' }, 404);
      const vs = await deps.db.select().from(variants).leftJoin(assets, eq(variants.renderAssetId, assets.id)).where(eq(variants.jobId, id));
      return json({
        job: { id: j.id, status: j.status, progress: j.progress, brief: j.brief, error: j.error, costUsd: j.costUsd, createdAt: j.createdAt, completedAt: j.completedAt },
        variants: vs
          .map(({ variants: v, assets: a }) => ({
            variantNo: v.variantNo, formatSlug: v.formatSlug, hookSlug: v.hookSlug, visualTreatment: v.visualTreatment,
            strategicBet: v.strategicBet, isExploratory: v.isExploratory, status: v.status, renderUrl: a ? storage.urlFor(a.storageKey) : null,
          }))
          .sort((a, b) => a.variantNo - b.variantNo),
      });
    },

    async getMedia(req: Request): Promise<Response> {
      let key: string;
      try { key = decodeURIComponent(new URL(req.url).pathname.replace(/^\/media\//, '')); } catch { return json({ error: 'invalid media key' }, 400); }
      let path: string;
      try { path = storage.pathFor(key); } catch { return json({ error: 'invalid media key' }, 400); }
      const bytes = await storage.read(key).catch(() => null);
      if (!bytes) return json({ error: 'not found' }, 404);
      const ext = path.split('.').pop()!;
      const type = ({ png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', mp4: 'video/mp4', wav: 'audio/wav' } as Record<string, string>)[ext] ?? 'application/octet-stream';
      // ponytail: no Range support — fine for start-to-end playback in the review UI; add byte ranges if scrubbing is needed.
      return new Response(bytes as Uint8Array<ArrayBuffer>, { headers: { 'content-type': type, 'content-length': String(bytes.byteLength), 'cache-control': 'public, max-age=31536000, immutable' } });
    },
  };
}
