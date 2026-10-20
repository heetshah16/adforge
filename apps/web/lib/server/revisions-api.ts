import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { EditOp, classifyEdit, compileProject, type ProjectBase } from '@adforge/core/project';
import type { BeatAssets } from '@adforge/core/spec/build-spec';
import { jobs, variantRevisions, variants } from '@adforge/db/schema';
import { revisionsForInsert } from '@adforge/db/revisions-insert';
import type { UserDb } from '@adforge/db/with-user';
import { isSiteOrigin } from './origin';
import { readTextCapped } from './read-capped';
import type { SessionUser } from './session';

/** Everything the revision routes touch, injected so tests can run them on PGlite with a fake session. */
export type RevisionsCtx = {
  auth(): Promise<SessionUser | Response>;
  run<T>(userId: string, fn: (udb: UserDb) => Promise<T>): Promise<T>;
  siteUrl: string;
  /** Queues adforge/variant.edit { revisionId }; called after the row commits. */
  send(revisionId: string): Promise<void>;
  /** Queues adforge/variant.export { revisionId }. */
  sendExport(revisionId: string): Promise<void>;
  /** Owner connection: marks a revision whose event could not be queued as failed. */
  fail(revisionId: string, reason: string): Promise<void>;
};

const MAX_JSON = 256 * 1024;
const json = (body: unknown, status = 200) => Response.json(body, { status });
const notFound = () => json({ error: 'not found' }, 404);
const forbidden = () => json({ error: 'forbidden' }, 403);
const Body = z.object({ parentId: z.uuid(), ops: z.array(EditOp).min(1).max(50) });
const isUuid = (s: string) => z.uuid().safeParse(s).success;

export async function listRevisionsHandler(ctx: RevisionsCtx, variantId: string): Promise<Response> {
  const user = await ctx.auth();
  if (user instanceof Response) return user;
  if (!isUuid(variantId)) return notFound();
  const rows = await ctx.run(user.userId, async (udb) => {
    const [v] = await udb.select({ id: variants.id }).from(variants).where(eq(variants.id, variantId));
    if (!v) return null;
    return udb.select({ id: variantRevisions.id, parentId: variantRevisions.parentId, ops: variantRevisions.ops, status: variantRevisions.status, locked: variantRevisions.locked, createdAt: variantRevisions.createdAt })
      .from(variantRevisions).where(eq(variantRevisions.variantId, variantId)).orderBy(asc(variantRevisions.createdAt), asc(variantRevisions.id));
  });
  if (!rows) return notFound();
  return json(rows.map((r) => ({ id: r.id, parentId: r.parentId, ops: r.ops, status: r.status, locked: r.locked, createdAt: r.createdAt.toISOString() })));
}

export async function createRevisionHandler(ctx: RevisionsCtx, req: Request, variantId: string): Promise<Response> {
  const user = await ctx.auth();
  if (user instanceof Response) return user;
  if (!isSiteOrigin(req, ctx.siteUrl)) return forbidden();
  if (!isUuid(variantId)) return notFound();
  const text = await readTextCapped(req, MAX_JSON);
  if (text === null) return json({ error: 'request too large' }, 413);
  const parsed = Body.safeParse((() => { try { return JSON.parse(text); } catch { return null; } })());
  if (!parsed.success) return json({ error: 'invalid request', issues: parsed.error.issues }, 400);
  const { parentId, ops } = parsed.data;

  const out = await ctx.run(user.userId, async (udb): Promise<Response | { id: string }> => {
    const [v] = await udb.select({ orgId: variants.orgId, status: variants.status, projectBase: variants.projectBase, input: jobs.inputSpec }).from(variants).innerJoin(jobs, eq(jobs.id, variants.jobId)).where(eq(variants.id, variantId));
    if (!v) return notFound();
    const chain = await udb.select({ id: variantRevisions.id, parentId: variantRevisions.parentId, ops: variantRevisions.ops, status: variantRevisions.status, locked: variantRevisions.locked })
      .from(variantRevisions).where(eq(variantRevisions.variantId, variantId));
    const byId = new Map(chain.map((r) => [r.id, r]));
    const parent = byId.get(parentId);
    if (!parent) return notFound();
    // lock is the lock route's. On a locked parent the ops must be an explicit [unlock, ...edits] (a locked revision is immutable, so editing it branches
    // a child that records the unlock); unlock anywhere else is refused.
    if (ops.some((o, i) => o.op === 'lock' || (o.op === 'unlock' && !(i === 0 && parent.locked)))) return json({ error: 'use the lock routes to lock; unlock is only valid as the first op on a locked revision' }, 409);
    if (parent.locked && ops[0]!.op !== 'unlock') return json({ error: 'revision is locked; start the ops with unlock' }, 409);
    if (parent.locked && ops.length === 1) return json({ error: 'unlock must be followed by an edit' }, 422);
    if (v.status === 'approved') return json({ error: 'variant is approved' }, 409);
    if (parent.status !== 'ready') return json({ error: 'revision is not ready' }, 409);
    if (ops.some((o) => classifyEdit(o) === 'structural')) return json({ error: 'structural edits arrive with Director v2' }, 422);
    if (!v.projectBase) return json({ error: 'variant has no editable project' }, 409);
    // A new Devanagari vo_tts can't be derived from edited text yet; the executor would fail the revision, so refuse it here.
    const lang = (v.input as { language?: string } | null)?.language;
    if (lang && lang !== 'en' && ops.some((o) => o.op === 'setField' && o.path === 'vo')) return json({ error: 'Hinglish VO edits arrive with C3' }, 422);
    // Effective ops = the chain from revision 0 to the parent. A newly posted op (by position) that drops for anything but missing_target is rejected.
    const inherited: EditOp[][] = [];
    for (let r: typeof parent | undefined = parent; r; r = r.parentId ? byId.get(r.parentId) : undefined) inherited.unshift(r.ops as EditOp[]);
    const all = [...inherited.flat(), ...ops];
    const firstNew = all.length - ops.length;
    const [{ beats }] = (await udb.select({ beats: variantRevisions.beats }).from(variantRevisions).where(eq(variantRevisions.id, parentId))) as [{ beats: unknown }];
    const { dropped } = compileProject({ base: v.projectBase as ProjectBase, ops: all }, beats as BeatAssets[]);
    const bad = dropped.filter((d) => all.indexOf(d.op) >= firstNew && d.reason !== 'missing_target');
    if (bad.length) return json({ error: 'invalid edit', dropped: bad }, 422);
    // beats, status and locked are never the caller's. ponytail: no row lock on the parent, so a lock racing this insert can leave an edit child under a just-locked parent; harmless, the parent stays immutable.
    const [row] = await udb.insert(revisionsForInsert).values({ orgId: v.orgId, variantId, parentId, ops, beats, status: 'pending', locked: false }).returning({ id: revisionsForInsert.id });
    return { id: row!.id };
  });
  if (out instanceof Response) return out;
  // After commit, so the worker can see the row.
  try {
    await ctx.send(out.id);
  } catch (e) {
    await ctx.fail(out.id, e instanceof Error ? e.message : String(e));
    return json({ error: 'could not queue the edit' }, 503);
  }
  return json({ revisionId: out.id }, 202);
}

export async function lockRevisionHandler(ctx: RevisionsCtx, req: Request, variantId: string, rev: string): Promise<Response> {
  const user = await ctx.auth();
  if (user instanceof Response) return user;
  if (!isSiteOrigin(req, ctx.siteUrl)) return forbidden();
  if (!isUuid(variantId) || !isUuid(rev)) return notFound();
  return ctx.run(user.userId, async (udb) => {
    const where = and(eq(variantRevisions.id, rev), eq(variantRevisions.variantId, variantId));
    const hit = await udb.update(variantRevisions).set({ locked: true }).where(and(where, eq(variantRevisions.status, 'ready'))).returning({ id: variantRevisions.id });
    if (hit.length) return json({ locked: rev });
    const [r] = await udb.select({ id: variantRevisions.id }).from(variantRevisions).where(where);
    return r ? json({ error: 'only a ready revision can be locked' }, 409) : notFound();
  });
}

export async function unlockRevisionHandler(ctx: RevisionsCtx, req: Request): Promise<Response> {
  const user = await ctx.auth();
  if (user instanceof Response) return user;
  if (!isSiteOrigin(req, ctx.siteUrl)) return forbidden();
  return json({ error: 'a locked revision is immutable; POST [unlock] as an edit to branch a new revision' }, 409);
}

/** Renders a ready revision of a variant the caller's org owns (RLS scopes the read). The worker's export is idempotent, so a repeat is harmless. */
export async function exportRevisionHandler(ctx: RevisionsCtx, req: Request, variantId: string, rev: string): Promise<Response> {
  const user = await ctx.auth();
  if (user instanceof Response) return user;
  if (!isSiteOrigin(req, ctx.siteUrl)) return forbidden();
  if (!isUuid(variantId) || !isUuid(rev)) return notFound();
  const r = await ctx.run(user.userId, async (udb) => {
    const [row] = await udb.select({ status: variantRevisions.status }).from(variantRevisions).where(and(eq(variantRevisions.id, rev), eq(variantRevisions.variantId, variantId)));
    return row ?? null;
  });
  if (!r) return notFound();
  if (r.status !== 'ready') return json({ error: 'only a ready revision can be exported' }, 409);
  try {
    await ctx.sendExport(rev);
  } catch {
    return json({ error: 'could not queue the export' }, 503);
  }
  return json({ revisionId: rev }, 202);
}
