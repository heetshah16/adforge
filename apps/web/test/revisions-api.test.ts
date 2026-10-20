import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDb } from '@adforge/db/client';
import { variantRevisions, variants } from '@adforge/db/schema';
import { withUser } from '@adforge/db/with-user';
import { compileProject } from '@adforge/core/project';
import { compileBeats, compileVariant } from './compile-fixture';
import { currentRevision } from '../lib/data/jobs';
import { approveHandler, type JobsCtx } from '../lib/server/jobs-api';
import { createRevisionHandler, exportRevisionHandler, listRevisionsHandler, lockRevisionHandler, unlockRevisionHandler, type RevisionsCtx } from '../lib/server/revisions-api';
import { dropTenants, makeTenant, type Tenant } from './tenant-fixture';

const SITE = 'http://w';
const req = (body?: unknown, origin: string | null = SITE) =>
  new Request('http://w/x', { method: 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...(origin ? { headers: { origin } } : {}) });
const MOVE = { op: 'move', layerId: 's2.headline', x: 0.1, y: 0.3 };
const UNLOCK = { op: 'unlock' };

describe('revision routes (pglite, fake session)', () => {
  let h: Awaited<ReturnType<typeof openDb>>;
  let a: Tenant;
  let b: Tenant;
  const sent: string[] = [];
  const failed: string[] = [];
  const exported: string[] = [];
  let sendError: Error | undefined;
  const ctxFor = (t: Tenant) =>
    ({
      siteUrl: SITE,
      auth: async () => ({ userId: t.userId, email: 'x@y.z', isAdmin: false, orgId: t.orgId }),
      run: (userId: string, fn: never) => withUser(h.db, userId, fn),
      send: async (id: string) => { if (sendError) throw sendError; sent.push(id); },
      sendExport: async (id: string) => { exported.push(id); },
      fail: async (id: string) => { failed.push(id); },
    }) as unknown as RevisionsCtx & JobsCtx;

  /** A variant with project_base and a locked ready revision 0, as generateAds leaves it. */
  async function seed(t: Tenant, variantNo: number) {
    const [v] = await h.db.select().from(variants).where(and(eq(variants.jobId, t.jobId), eq(variants.variantNo, variantNo)));
    const base = { id: `${t.jobId}-v${variantNo}`, variant: compileVariant(), theme: { primary: '#141414', accent: '#f5b301' } };
    const beats = compileBeats();
    await h.db.update(variants).set({ projectBase: base }).where(eq(variants.id, v!.id));
    const [r0] = await h.db.insert(variantRevisions).values({ orgId: t.orgId, variantId: v!.id, ops: [], beats, spec: compileProject({ base, ops: [] }, beats).spec, status: 'ready', locked: true }).returning();
    return { variantId: v!.id, rev0: r0!.id };
  }
  const post = (t: Tenant, variantId: string, body: unknown) => createRevisionHandler(ctxFor(t), req(body), variantId);
  const idOf = async (r: Response) => ((await r.json()) as { revisionId: string }).revisionId;
  const count = async (variantId: string) => (await h.db.select().from(variantRevisions).where(eq(variantRevisions.variantId, variantId))).length;
  /** The worker's side (owner connection); the executor does this in Task 4. */
  const ready = (id: string) => h.db.update(variantRevisions).set({ status: 'ready' }).where(eq(variantRevisions.id, id));
  /** rev0 -> an unlocked, ready child to edit from. */
  async function editable(t: Tenant, variantNo: number) {
    const s = await seed(t, variantNo);
    const id = await idOf(await post(t, s.variantId, { parentId: s.rev0, ops: [UNLOCK, MOVE] }));
    await ready(id);
    return { ...s, tip: id };
  }

  beforeAll(async () => {
    h = await openDb();
    a = await makeTenant(h.db, ['completed', 'completed', 'completed', 'completed', 'completed', 'completed', 'completed', 'completed', 'completed']);
    b = await makeTenant(h.db, ['completed']);
  });
  afterAll(async () => { await dropTenants(h.db, [a, b]); await h.close(); });

  it('chain rev0 -> rev1 -> rev2: GET lists all 3 with parent links; each POST sends the event; beats are copied server-side', async () => {
    const { variantId, rev0 } = await seed(a, 1);
    const id1 = await idOf(await post(a, variantId, { parentId: rev0, ops: [UNLOCK, MOVE] }));
    await ready(id1);
    const r2 = await post(a, variantId, { parentId: id1, ops: [MOVE] });
    expect(r2.status).toBe(202);
    const id2 = await idOf(r2);
    expect(sent.slice(-2)).toEqual([id1, id2]);
    const list = (await (await listRevisionsHandler(ctxFor(a), variantId)).json()) as { id: string; parentId: string | null; ops: unknown[]; status: string; locked: boolean }[];
    expect(list.map((r) => [r.id, r.parentId, r.status, r.locked])).toEqual([[rev0, null, 'ready', true], [id1, rev0, 'ready', false], [id2, id1, 'pending', false]]);
    expect(list[2]!.ops).toEqual([MOVE]);
    const [row] = await h.db.select().from(variantRevisions).where(eq(variantRevisions.id, id2));
    expect(row!.beats).toEqual(compileBeats());
    expect((await currentRevision(h.db, variantId))!.id).toBe(id2);
  });

  it('a locked parent rejects edits (409, no row); lock ops and misplaced unlock are refused; a pending parent is refused', async () => {
    const { variantId, rev0 } = await seed(a, 2);
    expect((await post(a, variantId, { parentId: rev0, ops: [MOVE] })).status).toBe(409);
    expect((await post(a, variantId, { parentId: rev0, ops: [MOVE, UNLOCK] })).status).toBe(409); // unlock must come first
    expect((await post(a, variantId, { parentId: rev0, ops: [UNLOCK, UNLOCK, MOVE] })).status).toBe(409);
    expect((await post(a, variantId, { parentId: rev0, ops: [UNLOCK, { op: 'lock' }, MOVE] })).status).toBe(409);
    const alone = await post(a, variantId, { parentId: rev0, ops: [UNLOCK] });
    expect([alone.status, await alone.json()]).toEqual([422, { error: 'unlock must be followed by an edit' }]);
    expect(await count(variantId)).toBe(1);
    const id1 = await idOf(await post(a, variantId, { parentId: rev0, ops: [UNLOCK, MOVE] }));
    expect((await post(a, variantId, { parentId: id1, ops: [MOVE] })).status).toBe(409); // pending
    await ready(id1);
    expect((await post(a, variantId, { parentId: id1, ops: [UNLOCK, MOVE] })).status).toBe(409); // already unlocked
    expect(await count(variantId)).toBe(2);
  });

  it('approve needs a locked current revision: 409 unlocked, 200 after POST lock; unlock route is 409', async () => {
    const { variantId, rev0 } = await seed(a, 3);
    const appr = () => approveHandler(ctxFor(a), req(), a.jobId, '3');
    const id1 = await idOf(await post(a, variantId, { parentId: rev0, ops: [UNLOCK, MOVE] }));
    const blocked = await appr();
    expect([blocked.status, await blocked.json()]).toEqual([409, { error: 'lock the current revision before approving' }]);
    expect((await lockRevisionHandler(ctxFor(a), req(), variantId, id1)).status).toBe(409); // pending: not lockable
    await ready(id1);
    expect((await appr()).status).toBe(409);
    expect((await lockRevisionHandler(ctxFor(a), req(), variantId, id1)).status).toBe(200);
    expect((await appr()).status).toBe(200);
    expect((await unlockRevisionHandler(ctxFor(a), req())).status).toBe(409);
    expect((await lockRevisionHandler(ctxFor(b), req(), variantId, id1)).status).toBe(404); // foreign org
    expect((await lockRevisionHandler(ctxFor(a), req(undefined, null), variantId, id1)).status).toBe(403);
  });

  it('an approved variant takes no more edits (409); a failed newest revision does not block approve', async () => {
    const x = await seed(a, 8);
    expect((await approveHandler(ctxFor(a), req(), a.jobId, '8')).status).toBe(200);
    const res = await post(a, x.variantId, { parentId: x.rev0, ops: [UNLOCK, MOVE] });
    expect([res.status, await res.json()]).toEqual([409, { error: 'variant is approved' }]);
    expect(await count(x.variantId)).toBe(1);
    const y = await seed(a, 9);
    const failedId = await idOf(await post(a, y.variantId, { parentId: y.rev0, ops: [UNLOCK, MOVE] }));
    expect((await approveHandler(ctxFor(a), req(), a.jobId, '9')).status).toBe(409); // pending unlocked tip
    await h.db.update(variantRevisions).set({ status: 'failed' }).where(eq(variantRevisions.id, failedId));
    expect((await currentRevision(h.db, y.variantId))!.id).toBe(y.rev0);
    expect((await approveHandler(ctxFor(a), req(), a.jobId, '9')).status).toBe(200);
  });

  it('a legacy variant with no revisions approves as before', async () => {
    expect((await approveHandler(ctxFor(a), req(), a.jobId, '4')).status).toBe(200);
  });

  it('two concurrent POSTs from the same parent give two sibling revisions with intact ops; current is the later one', async () => {
    const { variantId, tip } = await editable(a, 5);
    const m1 = { op: 'move', layerId: 's2.headline', x: 0.1, y: 0.3 };
    const m2 = { op: 'move', layerId: 's2.headline', x: 0.1, y: 0.28 };
    const [r1, r2] = await Promise.all([post(a, variantId, { parentId: tip, ops: [m1] }), post(a, variantId, { parentId: tip, ops: [m2] })]);
    expect([r1.status, r2.status], JSON.stringify([await r1.clone().json(), await r2.clone().json()])).toEqual([202, 202]);
    const ids = [await idOf(r1), await idOf(r2)];
    const rows = await h.db.select().from(variantRevisions).where(eq(variantRevisions.parentId, tip));
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === ids[0])!.ops).toEqual([m1]);
    expect(rows.find((r) => r.id === ids[1])!.ops).toEqual([m2]);
    const later = [...rows].sort((x, y) => y.createdAt.getTime() - x.createdAt.getTime() || (y.id < x.id ? -1 : 1))[0]!;
    expect((await currentRevision(h.db, variantId))!.id).toBe(later.id);
  });

  it('structural op -> 422 and no row; invalid ops -> 422 listing them; a valid move -> 202', async () => {
    const { variantId, tip } = await editable(a, 6);
    const before = await count(variantId);
    const s = await post(a, variantId, { parentId: tip, ops: [{ op: 'setField', beat: 0, path: 'format', value: 'x' }] });
    expect([s.status, await s.json()]).toEqual([422, { error: 'structural edits arrive with Director v2' }]);
    const off = await post(a, variantId, { parentId: tip, ops: [{ op: 'move', layerId: 's2.headline', x: 5, y: 5 }] });
    expect(off.status).toBe(422);
    expect(((await off.json()) as { dropped: { reason: string }[] }).dropped.map((d) => d.reason)).toEqual(['invalid']);
    const wrong = await post(a, variantId, { parentId: tip, ops: [MOVE, { op: 'retime', layerId: 'captions', reveal: { kind: 'scene', offsetFrames: 0 } }] });
    const body = (await wrong.json()) as { error: string; dropped: { op: { op: string }; reason: string }[] };
    expect([wrong.status, body.error, body.dropped.map((d) => [d.op.op, d.reason])]).toEqual([422, 'invalid edit', [['retime', 'wrong_target']]]);
    expect(await count(variantId)).toBe(before);
    expect((await post(a, variantId, { parentId: tip, ops: [MOVE] })).status).toBe(202);
    // A target gone in the base (missing_target) is legitimate history, not an error.
    expect((await post(a, variantId, { parentId: tip, ops: [{ op: 'move', layerId: 's9.headline', x: 0.1, y: 0.1 }] })).status).toBe(202);
  });

  it('validation, CSRF, foreign org, wrong parent, send failure', async () => {
    const { variantId, tip } = await editable(a, 7);
    const other = await seed(b, 1);
    expect((await post(a, variantId, { parentId: tip, ops: [] })).status).toBe(400);
    expect((await post(a, variantId, { parentId: tip, ops: Array(51).fill(MOVE) })).status).toBe(400);
    expect((await post(a, variantId, { parentId: 'nope', ops: [MOVE] })).status).toBe(400);
    expect((await createRevisionHandler(ctxFor(a), req({ parentId: tip, ops: [MOVE] }, 'http://evil.example'), variantId)).status).toBe(403);
    expect((await post(a, other.variantId, { parentId: other.rev0, ops: [UNLOCK] })).status).toBe(404); // foreign variant
    expect((await listRevisionsHandler(ctxFor(a), other.variantId)).status).toBe(404);
    expect((await post(a, variantId, { parentId: other.rev0, ops: [MOVE] })).status).toBe(404); // parent in another variant
    const before = await count(variantId);
    sendError = new Error('inngest down');
    try {
      const res = await post(a, variantId, { parentId: tip, ops: [MOVE] });
      expect(res.status).toBe(503);
    } finally { sendError = undefined; }
    expect(failed).toHaveLength(1);
    expect(await count(variantId)).toBe(before + 1);
  });

  it('export: 202 only for a ready revision the org owns; pending 409, foreign 404, CSRF 403', async () => {
    const c = await makeTenant(h.db, ['completed']);
    const { variantId, tip, rev0 } = await editable(c, 1);
    const pending = await idOf(await post(c, variantId, { parentId: tip, ops: [MOVE] }));
    const go = (t: Tenant, v: string, r: string, origin: string | null = SITE) => exportRevisionHandler(ctxFor(t), req(undefined, origin), v, r);
    expect((await go(c, variantId, tip)).status).toBe(202);
    expect(exported).toEqual([tip]);
    expect((await go(c, variantId, rev0)).status).toBe(202); // revision 0 is ready too
    expect((await go(c, variantId, pending)).status).toBe(409);
    expect((await go(b, variantId, tip)).status).toBe(404);
    expect((await go(c, variantId, tip, 'http://evil.example')).status).toBe(403);
    expect((await go(c, variantId, 'nope')).status).toBe(404);
    expect(exported).toEqual([tip, rev0]);
    await dropTenants(h.db, [c]);
  });
});
