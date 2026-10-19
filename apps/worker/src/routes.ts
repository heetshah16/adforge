import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { loadRegistry } from '@adforge/db/registry';
import { assets, jobs, variants } from '@adforge/db/schema';
import type { PipelineDeps } from '@adforge/pipeline';
import { MAX_BODY, parseJobUpload } from '@adforge/pipeline/job-input';
import { failJob } from '@adforge/pipeline/progress';
import { saveAsset } from '@adforge/pipeline/record';
import type { StorageProvider } from '@adforge/core/providers/types';
import { LocalDiskStorage } from '@adforge/provider-local-storage';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const bad = (error: string) => json({ error }, 400);

/** `operator` (seedOperator's ids) owns every job the dev route creates. */
export function makeRoutes(ctx: {
  deps: PipelineDeps; storage: StorageProvider; operator: { orgId: string; userId: string; projectId: string };
  sendEvent(name: string, data: unknown, id?: string): Promise<void>;
}) {
  const { deps, storage, operator } = ctx;

  return {
    async health() {
      return json({ ok: true });
    },

    async createJob(req: Request): Promise<Response> {
      if (Number(req.headers.get('content-length') ?? 0) > MAX_BODY) return json({ error: 'upload larger than 30 MB' }, 413);
      let form: FormData;
      try { form = await req.formData(); } catch { return bad('expected multipart/form-data'); }
      const parsed = await parseJobUpload(form);
      if (!parsed.ok) return json({ error: parsed.error, issues: parsed.issues }, parsed.status);
      const { fields: f, photos: loaded } = parsed;
      const photoKeys: string[] = [];
      for (const { bytes, type } of loaded) {
        const ref = await storage.put(bytes, { mime: type });
        await saveAsset(deps.db, operator, 'upload', ref);
        photoKeys.push(ref.id);
      }
      const [job] = await deps.db.insert(jobs).values({
        ...operator,
        inputSpec: { product: { name: f.name, price: f.price, description: f.description, ...(f.brand ? { brand: f.brand } : {}) }, language: f.language, broll: f.broll, photoKeys },
      }).returning();
      try {
        await ctx.sendEvent('adforge/job.requested', { jobId: job!.id }, job!.id);
      } catch (e) {
        await failJob(deps.db, job!.id, e instanceof Error ? e.message : String(e), 'enqueue');
        return json({ error: 'could not queue the job' }, 503);
      }
      return json({ jobId: job!.id }, 202);
    },

    /** Dev-only: apps/worker/src/e2e.ts polls it. The product API is apps/web's /api/jobs/[id] under RLS. */
    async getJob(req: Request): Promise<Response> {
      const id = new URL(req.url).pathname.split('/').pop() ?? '';
      if (!z.uuid().safeParse(id).success) return json({ error: 'not found' }, 404);
      const [j] = await deps.db.select().from(jobs).where(eq(jobs.id, id));
      if (!j) return json({ error: 'not found' }, 404);
      const vs = await deps.db.select().from(variants).leftJoin(assets, eq(variants.renderAssetId, assets.id)).where(eq(variants.jobId, id));
      const registry = await loadRegistry(deps.db);
      return json({
        job: { id: j.id, status: j.status, progress: j.progress, brief: j.brief, error: j.error, costUsd: j.costUsd, createdAt: j.createdAt, completedAt: j.completedAt },
        variants: vs
          .map(({ variants: v, assets: a }) => ({
            variantNo: v.variantNo, formatSlug: v.formatSlug, hookSlug: v.hookSlug, visualTreatment: v.visualTreatment,
            strategicBet: v.strategicBet, isExploratory: v.isExploratory, status: v.status, error: v.error,
            formatFamily: registry.formats.find((f) => f.slug === v.formatSlug)?.family ?? null,
            hookFamily: registry.hooks.find((h) => h.slug === v.hookSlug)?.family ?? null,
            renderUrl: a ? storage.urlFor(a.storageKey) : null,
          }))
          .sort((a, b) => a.variantNo - b.variantNo),
      });
    },

    async getMedia(req: Request): Promise<Response> {
      // Dev-only: under r2 media is served from R2 (B4 replaces this route).
      if (!(storage instanceof LocalDiskStorage)) return json({ error: 'not found' }, 404);
      let key: string;
      const reqUrl = new URL(req.url);
      try { key = decodeURIComponent(reqUrl.pathname.replace(/^\/media\//, '')); } catch { return json({ error: 'invalid media key' }, 400); }
      let path: string;
      try { path = storage.pathFor(key); } catch { return json({ error: 'invalid media key' }, 400); }
      const bytes = await storage.read(key).catch(() => null);
      if (!bytes) return json({ error: 'not found' }, 404);
      const ext = path.split('.').pop()!;
      const type = ({ png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', mp4: 'video/mp4', wav: 'audio/wav' } as Record<string, string>)[ext] ?? 'application/octet-stream';
      // ponytail: no Range support — fine for start-to-end playback in the review UI; add byte ranges if scrubbing is needed.
      const headers: Record<string, string> = { 'content-type': type, 'content-length': String(bytes.byteLength), 'cache-control': 'public, max-age=31536000, immutable' };
      // <a download> is ignored cross-origin, so the UI asks for an attachment explicitly.
      if (reqUrl.searchParams.get('download') === '1') headers['content-disposition'] = `attachment; filename="adforge-${key.split('/').pop()!.replace(/[\x00-\x1f"\\]/g, '_')}"`;
      return new Response(bytes as Uint8Array<ArrayBuffer>, { headers });
    },
  };
}
