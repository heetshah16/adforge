import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDb, openPostgres, type Db } from '@adforge/db/client';
import { memberships, orgs, users, waitlist } from '@adforge/db/schema';
import { ProvisionRefused, isEmailUniqueViolation, provisionWith } from '../lib/server/provision-owner';

type Handle = { db: Db; close(): Promise<void> };
const DEV = { adminEmails: [] as string[], prod: false };
const PROD = { adminEmails: [] as string[], prod: true };

function suite(name: string, open: () => Promise<Handle>, gated = false) {
  describe.skipIf(gated && !process.env.ADFORGE_TEST_DATABASE_URL)(`provision (${name})`, () => {
    let h: Handle;
    const made: { userIds: string[]; emails: string[] } = { userIds: [], emails: [] };
    const fresh = (prefix = 'u') => {
      const userId = randomUUID();
      const email = `${prefix}-${userId}@example.test`;
      made.userIds.push(userId);
      made.emails.push(email);
      return { userId, email };
    };
    const rows = async (userId: string) => ({
      users: await h.db.select().from(users).where(eq(users.id, userId)),
      memberships: await h.db.select().from(memberships).where(eq(memberships.userId, userId)),
    });
    const invite = (email: string, status: 'new' | 'invited' | 'joined') =>
      h.db.insert(waitlist).values({ name: 'W', email, brand: 'B', category: 'c', country: 'IN', status });

    beforeAll(async () => { h = await open(); });
    afterAll(async () => {
      if (gated && made.userIds.length) {
        const ms = await h.db.select().from(memberships).where(inArray(memberships.userId, made.userIds));
        await h.db.delete(memberships).where(inArray(memberships.userId, made.userIds));
        if (ms.length) await h.db.delete(orgs).where(inArray(orgs.id, ms.map((m) => m.orgId)));
        await h.db.delete(waitlist).where(inArray(waitlist.email, made.emails));
        await h.db.delete(users).where(inArray(users.id, made.userIds));
      }
      await h?.close();
    });

    it('twice sequentially: one user, one org, one owner membership', async () => {
      const a = fresh();
      const r1 = await provisionWith(h.db, a, DEV);
      const r2 = await provisionWith(h.db, a, DEV);
      expect(r2.orgId).toBe(r1.orgId);
      const r = await rows(a.userId);
      expect(r.users).toHaveLength(1);
      expect(r.memberships).toEqual([expect.objectContaining({ orgId: r1.orgId, role: 'owner' })]);
      const [org] = await h.db.select().from(orgs).where(eq(orgs.id, r1.orgId));
      expect(org?.name).toBe(a.email.split('@')[0]);
    });

    it('twice concurrently: still exactly one of each', async () => {
      const a = fresh();
      const out = await Promise.all([1, 2, 3, 4].map(() => provisionWith(h.db, a, DEV)));
      expect(new Set(out.map((o) => o.orgId)).size).toBe(1);
      const r = await rows(a.userId);
      expect(r.users).toHaveLength(1);
      expect(r.memberships).toHaveLength(1);
    });

    it('admin email sets isAdmin; others do not', async () => {
      const a = fresh('adm');
      const b = fresh('reg');
      expect((await provisionWith(h.db, a, { ...DEV, adminEmails: [a.email] })).isAdmin).toBe(true);
      expect((await provisionWith(h.db, b, DEV)).isAdmin).toBe(false);
      expect((await rows(a.userId)).users[0]?.isAdmin).toBe(true);
      expect((await rows(b.userId)).users[0]?.isAdmin).toBe(false);
    });

    it('marks the matching waitlist row joined', async () => {
      const a = fresh('wl');
      await invite(a.email, 'invited');
      await provisionWith(h.db, a, DEV);
      const [w] = await h.db.select().from(waitlist).where(eq(waitlist.email, a.email));
      expect(w?.status).toBe('joined');
    });

    it('prod: uninvited user is refused and nothing is created', async () => {
      const a = fresh('nope');
      await invite(a.email, 'new'); // on the waitlist but never invited
      await expect(provisionWith(h.db, a, PROD)).rejects.toMatchObject({ reason: 'not-invited' });
      await expect(provisionWith(h.db, a, PROD)).rejects.toBeInstanceOf(ProvisionRefused);
      const r = await rows(a.userId);
      expect(r.users).toHaveLength(0);
      expect(r.memberships).toHaveLength(0);
      const [w] = await h.db.select().from(waitlist).where(eq(waitlist.email, a.email));
      expect(w?.status).toBe('new');
    });

    it('prod: invited user succeeds (case-insensitive waitlist match)', async () => {
      const a = fresh('inv');
      await invite(a.email.toUpperCase(), 'invited');
      const r = await provisionWith(h.db, a, PROD);
      expect((await rows(a.userId)).memberships).toEqual([expect.objectContaining({ orgId: r.orgId })]);
    });

    it('prod: admin succeeds without an invite', async () => {
      const a = fresh('padm');
      const r = await provisionWith(h.db, a, { adminEmails: [a.email], prod: true });
      expect(r.isAdmin).toBe(true);
      expect((await rows(a.userId)).memberships).toHaveLength(1);
    });

    it('prod: existing member succeeds without an invite', async () => {
      const a = fresh('mem');
      const first = await provisionWith(h.db, a, DEV);
      const again = await provisionWith(h.db, a, PROD);
      expect(again.orgId).toBe(first.orgId);
    });

    it('same email, different auth id: refused as conflict, nothing re-keyed or created', async () => {
      const a = fresh('dup');
      const first = await provisionWith(h.db, a, DEV);
      const b = { userId: randomUUID(), email: a.email };
      made.userIds.push(b.userId);
      await expect(provisionWith(h.db, b, DEV)).rejects.toMatchObject({ reason: 'conflict' });
      expect((await rows(b.userId)).users).toHaveLength(0);
      expect((await rows(b.userId)).memberships).toHaveLength(0);
      const [u] = (await rows(a.userId)).users;
      expect(u?.id).toBe(a.userId);
      expect((await rows(a.userId)).memberships).toEqual([expect.objectContaining({ orgId: first.orgId })]);
    });

    it('concurrent first logins, same email, different ids: exactly one wins, the other is a conflict (not a raw error)', async () => {
      const a = fresh('race');
      const b = { userId: randomUUID(), email: a.email };
      made.userIds.push(b.userId);
      const res = await Promise.allSettled([provisionWith(h.db, a, DEV), provisionWith(h.db, b, DEV)]);
      expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const lost = res.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect(lost.reason).toBeInstanceOf(ProvisionRefused);
      expect(lost.reason.reason).toBe('conflict');
    });
  });
}

describe('isEmailUniqueViolation', () => {
  it('matches 23505 on the email constraint, also under drizzle cause wrapping', () => {
    const pg = { code: '23505', constraint_name: 'users_email_unique' };
    expect(isEmailUniqueViolation(pg)).toBe(true);
    expect(isEmailUniqueViolation(Object.assign(new Error('Failed query'), { cause: pg }))).toBe(true);
    expect(isEmailUniqueViolation({ code: '23505', message: 'duplicate key value violates unique constraint "users_email_unique"' })).toBe(true);
  });
  it('ignores other violations and errors', () => {
    expect(isEmailUniqueViolation({ code: '23505', constraint_name: 'memberships_pkey' })).toBe(false);
    expect(isEmailUniqueViolation({ code: '40001' })).toBe(false);
    expect(isEmailUniqueViolation(new Error('x'))).toBe(false);
    expect(isEmailUniqueViolation(undefined)).toBe(false);
  });
});

suite('pglite', () => openDb());
suite('postgres', () => openPostgres(process.env.ADFORGE_TEST_DATABASE_URL!), true);
