import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDb } from '@adforge/db/client';
import { memberships, orgs, users, waitlist } from '@adforge/db/schema';
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
        if (inviteError) throw new Error('rate limit exceeded');
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
    expect((await (await inviteHandler(ctx, post({ waitlistId: w.id }))).json()).error).toContain('rate limit exceeded');
    const r = await row(w.id);
    expect([r.status, r.invitedAt]).toEqual(['new', null]);
  });

  it('markInvited never moves a joined row back to invited', async () => {
    const w = await add('guard@x.com');
    await h.db.update(waitlist).set({ status: 'joined' }).where(eq(waitlist.id, w.id));
    await markInvited(h.db, w.id);
    expect((await row(w.id)).status).toBe('joined');
  });

  it('lists waitlist newest first (exact order)', async () => {
    const ids: string[] = [];
    for (const [i, d] of [[1, '2030-01-01'], [2, '2030-03-01'], [3, '2030-02-01']] as const) {
      const [r] = await h.db.insert(waitlist).values({ name: 'N', email: `ord${i}@x.com`, brand: 'B', category: 'C', country: 'IN', createdAt: new Date(d) }).returning();
      ids.push(r!.id);
    }
    const got = (await listWaitlist(h.db)).filter((r) => ids.includes(r.id)).map((r) => r.id);
    expect(got).toEqual([ids[1], ids[2], ids[0]]);
  });

  it('org member counts are exact', async () => {
    const [a, b] = await h.db.insert(orgs).values([{ name: 'CountA' }, { name: 'CountB' }]).returning();
    const us = await h.db.insert(users).values([{ email: 'm1@x.com' }, { email: 'm2@x.com' }]).returning();
    await h.db.insert(memberships).values(us.map((u) => ({ orgId: a!.id, userId: u.id, role: 'member' as const })));
    const got = (await listOrgsWithCounts(h.db)).filter((o) => [a!.id, b!.id].includes(o.id));
    expect(Object.fromEntries(got.map((o) => [o.name, o.members]))).toEqual({ CountA: 2, CountB: 0 });
  });
});
