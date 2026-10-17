import { z } from 'zod';
import type { MediaRef } from '@adforge/core/providers/types';
import { MAX_BODY, parseJobUpload } from '@adforge/pipeline/job-input';
import { saveAsset } from '@adforge/pipeline/record';
import type { UserDb } from '@adforge/db/with-user';
import type { LocalDiskStorage } from '@adforge/provider-local-storage';
import { approveVariant, createJobRow, ensureDefaultProject, getJobView } from '../data/jobs';
import type { SessionUser } from './session';

/** Everything the job routes touch, injected so tests can run them on PGlite with a fake session. */
export type JobsCtx = {
  auth(): Promise<SessionUser | Response>;
  run<T>(userId: string, fn: (udb: UserDb) => Promise<T>): Promise<T>;
  storage: LocalDiskStorage;
  send(jobId: string): Promise<void>;
  fail(jobId: string, reason: string, stage: string): Promise<void>;
};

const json = (body: unknown, status = 200) => Response.json(body, { status });
const isRetryable = (e: unknown) => {
  for (let x = e as { code?: string; cause?: unknown } | undefined, i = 0; x && i < 4; x = x.cause as typeof x, i++) if (x.code === '40P01' || x.code === '40001') return true;
  return false;
};
const notFound = () => json({ error: 'not found' }, 404);

export async function createJobHandler(ctx: JobsCtx, req: Request): Promise<Response> {
  const user = await ctx.auth();
  if (user instanceof Response) return user;
  if (Number(req.headers.get('content-length') ?? 0) > MAX_BODY) return json({ error: 'upload larger than 30 MB' }, 413);
  let form: FormData;
  try { form = await req.formData(); } catch { return json({ error: 'expected multipart/form-data' }, 400); }
  const parsed = await parseJobUpload(form);
  if (!parsed.ok) return json({ error: parsed.error, issues: parsed.issues }, parsed.status);
  const { fields: f, photos } = parsed;
  const refs: MediaRef[] = [];
  for (const { bytes, type } of photos) refs.push(await ctx.storage.put(bytes, { mime: type }));
  const jobId = await ctx.run(user.userId, async (udb) => {
    const projectId = await ensureDefaultProject(udb, user);
    for (const ref of refs) await saveAsset(udb, { orgId: user.orgId, projectId }, 'upload', ref);
    return createJobRow(udb, {
      orgId: user.orgId, projectId, userId: user.userId,
      inputSpec: { product: { name: f.name, price: f.price, description: f.description, ...(f.brand ? { brand: f.brand } : {}) }, language: f.language, broll: f.broll, photoKeys: refs.map((r) => r.id) },
    });
  });
  // After commit, so the worker can see the row.
  try {
    await ctx.send(jobId);
  } catch (e) {
    await ctx.fail(jobId, e instanceof Error ? e.message : String(e), 'enqueue');
    return json({ error: 'could not queue the job' }, 503);
  }
  return json({ jobId }, 202);
}

export async function getJobHandler(ctx: JobsCtx, id: string): Promise<Response> {
  const user = await ctx.auth();
  if (user instanceof Response) return user;
  if (!z.uuid().safeParse(id).success) return notFound();
  const view = await ctx.run(user.userId, (udb) => getJobView(udb, id, (k) => ctx.storage.urlFor(k)));
  return view ? json(view) : notFound();
}

export async function approveHandler(ctx: JobsCtx, id: string, nRaw: string): Promise<Response> {
  const user = await ctx.auth();
  if (user instanceof Response) return user;
  const n = Number(nRaw);
  if (!z.uuid().safeParse(id).success || !/^\d+$/.test(nRaw) || !Number.isSafeInteger(n) || n < 1 || n > 2 ** 31 - 1) return notFound();
  const attempt = () => ctx.run(user.userId, (udb) => approveVariant(udb, id, n));
  // Concurrent approves lock the same rows; if Postgres picks this one as a deadlock/serialization victim, the retry sees the winner's commit.
  const r = await attempt().catch((e) => { if (isRetryable(e)) return attempt(); throw e; });
  return r === 'ok' ? json({ approved: n }) : r === 'not_found' ? notFound() : json({ error: `variant ${n} is not ready to approve` }, 409);
}
