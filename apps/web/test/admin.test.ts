import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDb } from '@adforge/db/client';
import { waitlist } from '@adforge/db/schema';
import { inviteHandler, type AdminCtx } from '../lib/server/admin-api';
import { getWaitlistEntry, listOrgsWithCounts, listWaitlist, markInvited } from '../lib/server/admin-owner';

const SITE = 'https://adforge.example';
const admin = { userId: randomUUID(), email: 'a@x.com', isAdmin: true, orgId: randomUUID() };
const post = (body: unknown, origin: string | null = SITE) =>
  new Request(`${SITE}/api/admin/invite`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify(body),
  });

describe('admin invite (pglite)', () => {
  let h: Awaited<ReturnType<typeof openDb>>;
  let calls: { email: string; redirectTo: string }[];
  let inviteError: boolean;
  let user: typeof admin | Response;
  let ctx: AdminCtx;
  const add = async (email: string) => {
    const [r] = await h.db.insert(waitlist).values({ name: 'N', email, brand: 'B', category: 'C', country: 'IN' }).returning();
    return r!;
  };
  const row = async (id: string) => (await h.db.select().from(waitlist).where(eq(waitlist.id, id)))[0]!;

  beforeAll(async () => {
    h = await openDb();
    ctx = {
      requireUser: async () => user,
      siteUrl: SITE,
      get: (id) => getWaitlistEntry(h.db, id),
      markInvited: (id) => markInvited(h.db, id),
      invite: async (email, redirectTo) => {
        if (inviteError) throw new Error('boom');
        calls.push({ email, redirectTo });
      },
    };
  });
  afterAll(async () => { await h.close(); });
  const reset = () => { calls = []; inviteError = false; user = admin; };

  it('non-admin gets 404 and no invite', async () => {
    reset();
    const w = await add('na@x.com');
    user = { ...admin, isAdmin: false };
    expect((await inviteHandler(ctx, post({ waitlistId: w.id }))).status).toBe(404);
    expect(calls).toEqual([]);
  });

  it('unauthenticated response passes through', async () => {
    reset();
    user = Response.json({ error: 'unauthenticated' }, { status: 401 });
    expect((await inviteHandler(ctx, post({ waitlistId: randomUUID() }))).status).toBe(401);
  });

  it('bad origin -> 403', async () => {
    reset();
    const w = await add('bo@x.com');
    expect((await inviteHandler(ctx, post({ waitlistId: w.id }, 'https://evil.example'))).status).toBe(403);
    expect((await inviteHandler(ctx, post({ waitlistId: w.id }, null))).status).toBe(403);
    expect(calls).toEqual([]);
  });

  it('invite marks the row invited and passes redirectTo', async () => {
    reset();
    const w = await add('ok@x.com');
    const res = await inviteHandler(ctx, post({ waitlistId: w.id }));
    expect(res.status).toBe(200);
    expect(calls).toEqual([{ email: 'ok@x.com', redirectTo: `${SITE}/auth/confirm` }]);
    const r = await row(w.id);
    expect(r.status).toBe('invited');
    expect(r.invitedAt).toBeInstanceOf(Date);
  });

  it('second invite is 200 without calling the client again', async () => {
    reset();
    const w = await add('twice@x.com');
    await inviteHandler(ctx, post({ waitlistId: w.id }));
    const res = await inviteHandler(ctx, post({ waitlistId: w.id }));
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it('joined row is 200 without a send', async () => {
    reset();
    const w = await add('joined@x.com');
    await h.db.update(waitlist).set({ status: 'joined' }).where(eq(waitlist.id, w.id));
    expect((await inviteHandler(ctx, post({ waitlistId: w.id }))).status).toBe(200);
    expect(calls).toEqual([]);
    expect((await row(w.id)).status).toBe('joined');
  });

  it('unknown or malformed id -> 404; bad body -> 400', async () => {
    reset();
    expect((await inviteHandler(ctx, post({ waitlistId: randomUUID() }))).status).toBe(404);
    expect((await inviteHandler(ctx, post({ waitlistId: 'nope' }))).status).toBe(404);
    expect((await inviteHandler(ctx, post({}))).status).toBe(400);
  });

  it('invite API error -> 502 and row unchanged', async () => {
    reset();
    const w = await add('fail@x.com');
    inviteError = true;
    expect((await inviteHandler(ctx, post({ waitlistId: w.id }))).status).toBe(502);
    const r = await row(w.id);
    expect([r.status, r.invitedAt]).toEqual(['new', null]);
  });

  it('lists waitlist newest first and orgs with member counts', async () => {
    const list = await listWaitlist(h.db);
    for (let i = 1; i < list.length; i++) expect(list[i - 1]!.createdAt >= list[i]!.createdAt).toBe(true);
    expect(Array.isArray(await listOrgsWithCounts(h.db))).toBe(true);
  });
});
