import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDb, openPostgres, type Db } from '@adforge/db/client';
import { memberships, orgs, users, waitlist } from '@adforge/db/schema';
import { provision } from '../lib/server/provision-owner';

type Handle = { db: Db; close(): Promise<void> };

function suite(name: string, open: () => Promise<Handle>, gated = false) {
  describe.skipIf(gated && !process.env.ADFORGE_TEST_DATABASE_URL)(`provision (${name})`, () => {
    let h: Handle;
    const made: { userIds: string[]; emails: string[] } = { userIds: [], emails: [] };
    const fresh = (prefix = 'u') => {
      const userId = randomUUID();
      const email = `${prefix}-${userId}@example.test`;
      made.userIds.push(userId);
      made.emails.push(email);
      return { userId, email, adminEmails: [] as string[] };
    };
    const rows = async (userId: string) => ({
      users: await h.db.select().from(users).where(eq(users.id, userId)),
      memberships: await h.db.select().from(memberships).where(eq(memberships.userId, userId)),
    });

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
      const r1 = await provision(h.db, a);
      const r2 = await provision(h.db, a);
      expect(r2.orgId).toBe(r1.orgId);
      const r = await rows(a.userId);
      expect(r.users).toHaveLength(1);
      expect(r.memberships).toEqual([expect.objectContaining({ orgId: r1.orgId, role: 'owner' })]);
      const [org] = await h.db.select().from(orgs).where(eq(orgs.id, r1.orgId));
      expect(org?.name).toBe(a.email.split('@')[0]);
    });

    it('twice concurrently: still exactly one of each', async () => {
      const a = fresh();
      const out = await Promise.all([provision(h.db, a), provision(h.db, a), provision(h.db, a), provision(h.db, a)]);
      expect(new Set(out.map((o) => o.orgId)).size).toBe(1);
      const r = await rows(a.userId);
      expect(r.users).toHaveLength(1);
      expect(r.memberships).toHaveLength(1);
    });

    it('admin email sets isAdmin; others do not', async () => {
      const a = fresh('adm');
      const b = fresh('reg');
      await provision(h.db, { ...a, adminEmails: [a.email] });
      await provision(h.db, b);
      expect((await rows(a.userId)).users[0]?.isAdmin).toBe(true);
      expect((await rows(b.userId)).users[0]?.isAdmin).toBe(false);
    });

    it('marks the matching waitlist row joined', async () => {
      const a = fresh('wl');
      await h.db.insert(waitlist).values({ name: 'W', email: a.email, brand: 'B', category: 'c', country: 'IN', status: 'invited' });
      await provision(h.db, a);
      const [w] = await h.db.select().from(waitlist).where(eq(waitlist.email, a.email));
      expect(w?.status).toBe('joined');
    });
  });
}

suite('pglite', () => openDb());
suite('postgres', () => openPostgres(process.env.ADFORGE_TEST_DATABASE_URL!), true);
