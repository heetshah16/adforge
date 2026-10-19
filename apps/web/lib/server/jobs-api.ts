import { z } from 'zod';
import type { MediaRef } from '@adforge/core/providers/types';
import { MIME_EXT, orgKey, parseKey } from '@adforge/core/providers/storage-key';
import { MAX_PHOTO, PHOTO_TYPES, parseJobRequest } from '@adforge/pipeline/job-input';
import { saveAsset } from '@adforge/pipeline/record';
import type { UserDb } from '@adforge/db/with-user';
import type { StorageProvider } from '@adforge/core/providers/types';
import { approveVariant, createJobRow, ensureDefaultProject, getJobView } from '../data/jobs';
import { isSiteOrigin } from './origin';
import { readTextCapped } from './read-capped';
import type { SessionUser } from './session';

/** Everything the job routes touch, injected so tests can run them on PGlite with a fake session. */
export type JobsCtx = {
  auth(): Promise<SessionUser | Response>;
  run<T>(userId: string, fn: (udb: UserDb) => Promise<T>): Promise<T>;
  siteUrl: string;
  /** Same meaning as UploadsCtx.r2: org-prefixed keys when true. */
  r2: boolean;
  storage: StorageProvider & { head(key: string): Promise<{ bytes: number; mime: string } | null> };
  send(jobId: string): Promise<void>;
  fail(jobId: string, reason: string, stage: string): Promise<void>;
};

/** The job request is JSON fields plus up to five storage keys. */
const MAX_JSON = 16 * 1024;
const json = (body: unknown, status = 200) => Response.json(body, { status });
const isRetryable = (e: unknown) => {
  for (let x = e as { code?: string; cause?: unknown } | undefined, i = 0; x && i < 4; x = x.cause as typeof x, i++) if (x.code === '40P01' || x.code === '40001') return true;
  return false;
};
const notFound = () => json({ error: 'not found' }, 404);
// CSRF: state-changing, so only our own origin may call it.
const forbidden = () => json({ error: 'forbidden' }, 403);

export async function createJobHandler(ctx: JobsCtx, req: Request): Promise<Response> {
  const user = await ctx.auth();
  if (user instanceof Response) return user;
  if (!isSiteOrigin(req, ctx.siteUrl)) return forbidden();
  const text = await readTextCapped(req, MAX_JSON);
  if (text === null) return json({ error: 'request too large' }, 413);
  const parsed = parseJobRequest((() => { try { return JSON.parse(text); } catch { return null; } })());
  if (!parsed.ok) return json({ error: parsed.error, issues: parsed.issues }, parsed.status);
  const { fields: f, photoKeys } = parsed;
  // Every key came from the browser: check tenancy and existence for all of them before any row is written.
  const refs: MediaRef[] = [];
  for (const [i, key] of photoKeys.entries()) {
    const { org: owner, sha, ext } = parseKey(key)!; // parseJobRequest already checked the shape
    if (ctx.r2) {
      // A dev-shaped key (no org) is as foreign as another org's; the shard must also match the sha.
      if (owner !== user.orgId || key !== orgKey(owner, sha, ext)) return json({ error: 'photo key belongs to another account' }, 403);
    } else if (owner !== null || key.slice(0, 2) !== sha.slice(0, 2)) return json({ error: `photo ${i + 1}: invalid key` }, 400);
    const head = await ctx.storage.head(key);
    if (!head) return json({ error: `photo ${i + 1} was not uploaded` }, 400);
    if (!PHOTO_TYPES.includes(head.mime) || MIME_EXT[head.mime] !== ext) return json({ error: `photo ${i + 1}: unsupported type (png, jpeg, webp only)` }, 400);
    if (head.bytes > MAX_PHOTO) return json({ error: `photo ${i + 1}: larger than 10 MB` }, 400);
    refs.push({ id: key, url: ctx.storage.urlFor(key), mime: head.mime, sha256: sha, bytes: head.bytes });
  }
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

export async function approveHandler(ctx: JobsCtx, req: Request, id: string, nRaw: string): Promise<Response> {
  const user = await ctx.auth();
  if (user instanceof Response) return user;
  if (!isSiteOrigin(req, ctx.siteUrl)) return forbidden();
  const n = Number(nRaw);
  if (!z.uuid().safeParse(id).success || !/^\d+$/.test(nRaw) || !Number.isSafeInteger(n) || n < 1 || n > 2 ** 31 - 1) return notFound();
  const attempt = () => ctx.run(user.userId, (udb) => approveVariant(udb, id, n));
  // Concurrent approves lock the same rows; if Postgres picks this one as a deadlock/serialization victim, the retry sees the winner's commit.
  const r = await attempt().catch((e) => { if (isRetryable(e)) return attempt(); throw e; });
  return r === 'ok' ? json({ approved: n }) : r === 'not_found' ? notFound() : json({ error: `variant ${n} is not ready to approve` }, 409);
}
