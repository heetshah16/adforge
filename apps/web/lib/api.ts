import { z } from 'zod';

export const WORKER = (process.env.NEXT_PUBLIC_WORKER_URL ?? 'http://127.0.0.1:3001').replace(/\/+$/, '');
const T = () => AbortSignal.timeout(10_000);

const Progress = z.object({ stage: z.string(), status: z.enum(['running', 'done', 'failed', 'skipped']), at: z.string(), detail: z.string().optional() });
const Variant = z.object({
  variantNo: z.number(), formatSlug: z.string(), formatFamily: z.string().nullable(), hookSlug: z.string(), hookFamily: z.string().nullable(),
  visualTreatment: z.string(), strategicBet: z.string(), isExploratory: z.boolean(),
  status: z.enum(['pending', 'running', 'completed', 'failed', 'approved']), error: z.unknown().nullable(), renderUrl: z.string().nullable(),
});
const JobViewSchema = z.object({
  job: z.object({
    id: z.string(), status: z.enum(['queued', 'running', 'completed', 'failed']), progress: z.array(Progress),
    brief: z.unknown().nullable(), error: z.unknown().nullable(), costUsd: z.number(), createdAt: z.string(), completedAt: z.string().nullable(),
  }),
  variants: z.array(Variant),
});
export type JobView = z.infer<typeof JobViewSchema>;

export async function createJob(form: FormData, fetchImpl: typeof fetch = fetch) {
  const res = await fetchImpl(`${WORKER}/api/jobs`, { method: 'POST', body: form, signal: T() });
  const body = (await res.json().catch(() => ({}))) as { jobId?: string; error?: string; issues?: Record<string, string[]> };
  if (res.status === 202 && body.jobId) return { ok: true as const, jobId: body.jobId };
  return { ok: false as const, error: body.error ?? `upload failed (HTTP ${res.status})`, ...(body.issues ? { issues: body.issues } : {}) };
}

export async function getJob(id: string, fetchImpl: typeof fetch = fetch): Promise<JobView> {
  const res = await fetchImpl(`${WORKER}/api/jobs/${encodeURIComponent(id)}`, { signal: T() });
  if (!res.ok) throw new Error(`job ${id}: HTTP ${res.status}`);
  return JobViewSchema.parse(await res.json());
}

export async function approveVariant(id: string, n: number, fetchImpl: typeof fetch = fetch): Promise<void> {
  const res = await fetchImpl(`${WORKER}/api/jobs/${encodeURIComponent(id)}/variants/${n}/approve`, { method: 'POST', signal: T() });
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `approve failed (HTTP ${res.status})`);
}
