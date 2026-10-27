import { z } from 'zod';

import { VideoSpec } from '@adforge/core/spec/video-spec';
import { NOT_INVITED } from './not-invited';

const T = () => AbortSignal.timeout(10_000);
/** Same-origin /api routes. 401 = the session ended: sign in again. 403 only means "not invited" (-> waitlist) when the body says so; other 403s are real errors. */
const signedOut = async (res: Response) => {
  if (typeof location === 'undefined') return;
  if (res.status === 401) location.assign('/signin');
  else if (res.status === 403 && ((await res.clone().json().catch(() => ({}))) as { error?: string }).error === NOT_INVITED) location.assign('/waitlist');
};

const Progress = z.object({ stage: z.string(), status: z.enum(['running', 'done', 'failed', 'skipped']), at: z.string(), detail: z.string().optional() });
const Variant = z.object({
  variantNo: z.number(), formatSlug: z.string(), formatFamily: z.string().nullable(), hookSlug: z.string(), hookFamily: z.string().nullable(),
  visualTreatment: z.string(), strategicBet: z.string(), isExploratory: z.boolean(),
  status: z.enum(['pending', 'running', 'completed', 'failed', 'approved']), error: z.unknown().nullable(), renderUrl: z.string().nullable(),
  /** The current revision (null: a legacy variant). needsExport: an edited revision (has a parent) with no export yet. spec only when ready; assetUrls maps each spec storage key to its storage.urlFor URL. */
  revision: z.object({ id: z.string(), status: z.enum(['pending', 'ready', 'failed']), locked: z.boolean(), needsExport: z.boolean(), spec: VideoSpec.nullable(), assetUrls: z.record(z.string(), z.string()) }).nullable(),
});
const JobViewSchema = z.object({
  job: z.object({
    id: z.string(), status: z.enum(['queued', 'running', 'completed', 'failed']), progress: z.array(Progress),
    brief: z.unknown().nullable(), error: z.unknown().nullable(), costUsd: z.number(), createdAt: z.string(), completedAt: z.string().nullable(),
  }),
  variants: z.array(Variant),
  /** Queue position/ETA from queueStatusOwner; null once the job leaves queued/running. Tolerates absence for older payloads. */
  queue: z.object({ position: z.number().int().positive(), etaRange: z.union([z.tuple([z.number(), z.number()]), z.literal('paused')]) }).nullable().optional(),
});
export type JobView = z.infer<typeof JobViewSchema>;

const hex = async (file: File) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()))].map((b) => b.toString(16).padStart(2, '0')).join('');
type Fail = { ok: false; error: string; issues?: Record<string, string[]> };

/** Photos go straight to storage (presigned PUT in prod); only their keys travel with the job fields. */
export async function createJob(form: FormData, fetchImpl: typeof fetch = fetch): Promise<{ ok: true; jobId: string } | Fail> {
  const photoKeys: string[] = [];
  const files = form.getAll('photos').filter((f): f is File => f instanceof File && f.size > 0);
  for (const [i, file] of files.entries()) {
    const mint = await fetchImpl(`/api/uploads`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mime: file.type, bytes: file.size, sha256: await hex(file) }), signal: T() });
    await signedOut(mint);
    const m = (await mint.json().catch(() => ({}))) as { key?: string; url?: string; headers?: Record<string, string>; exists?: boolean; error?: string };
    if (!mint.ok || !m.key) return { ok: false, error: m.error ?? `photo ${i + 1}: upload failed (HTTP ${mint.status})` };
    if (!m.exists) {
      if (!m.url) return { ok: false, error: `photo ${i + 1}: upload failed` };
      const put = await fetchImpl(m.url, { method: 'PUT', headers: m.headers, body: file, signal: AbortSignal.timeout(120_000) }).catch((e: unknown) => {
        if (e instanceof DOMException && (e.name === 'TimeoutError' || e.name === 'AbortError')) return null;
        throw e;
      });
      if (!put) return { ok: false, error: `photo ${i + 1}: upload timed out` };
      // 412: the signed if-none-match found the object already stored (content-addressed), so the upload is done.
      // R2 error responses may lack CORS headers, so the browser can report a network error instead of the 412;
      // a retry recovers because mint then returns exists:true.
      if (!put.ok && put.status !== 412) return { ok: false, error: `photo ${i + 1}: upload failed (HTTP ${put.status})` };
    }
    photoKeys.push(m.key);
  }
  const text = (k: string) => String(form.get(k) ?? '');
  const payload = { name: text('name'), price: text('price'), description: text('description'), brand: text('brand') || undefined, language: text('language'), broll: ['on', 'true'].includes(text('broll')), photoKeys };
  const res = await fetchImpl(`/api/jobs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: T() });
  await signedOut(res);
  const body = (await res.json().catch(() => ({}))) as { jobId?: string; error?: string; issues?: Record<string, string[]> };
  if (res.status === 202 && body.jobId) return { ok: true, jobId: body.jobId };
  return { ok: false, error: body.error ?? `upload failed (HTTP ${res.status})`, ...(body.issues ? { issues: body.issues } : {}) };
}

export async function getJob(id: string, fetchImpl: typeof fetch = fetch): Promise<JobView> {
  const res = await fetchImpl(`/api/jobs/${encodeURIComponent(id)}`, { signal: T() });
  await signedOut(res);
  if (!res.ok) throw new Error(`job ${id}: HTTP ${res.status}`);
  return JobViewSchema.parse(await res.json());
}

export async function approveVariant(id: string, n: number, fetchImpl: typeof fetch = fetch): Promise<void> {
  const res = await fetchImpl(`/api/jobs/${encodeURIComponent(id)}/variants/${n}/approve`, { method: 'POST', signal: T() });
  await signedOut(res);
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `approve failed (HTTP ${res.status})`);
}
