import { and, eq, ne } from 'drizzle-orm';
import type { Db } from '@adforge/db/client';
import { memberships, orgs, users, waitlist } from '@adforge/db/schema';

/**
 * First-login provisioning (owner connection: RLS cannot bootstrap its own tenancy). Idempotent and concurrency-safe:
 * the users upsert row-locks until commit, so a parallel call blocks there, then sees the membership the first one made.
 */
export function provision(db: Db, p: { userId: string; email: string; adminEmails: string[] }): Promise<{ orgId: string }> {
  const email = p.email.toLowerCase();
  const isAdmin = p.adminEmails.includes(email);
  return db.transaction(async (tx) => {
    await tx.insert(users).values({ id: p.userId, email, isAdmin }).onConflictDoUpdate({ target: users.id, set: { email, isAdmin } });
    const [m] = await tx.select({ orgId: memberships.orgId }).from(memberships).where(eq(memberships.userId, p.userId)).orderBy(memberships.createdAt).limit(1);
    let orgId = m?.orgId;
    if (!orgId) {
      const [o] = await tx.insert(orgs).values({ name: email.split('@')[0]! }).returning({ id: orgs.id });
      orgId = o!.id;
      await tx.insert(memberships).values({ orgId, userId: p.userId, role: 'owner' });
    }
    await tx.update(waitlist).set({ status: 'joined' }).where(and(eq(waitlist.email, email), ne(waitlist.status, 'joined')));
    return { orgId };
  });
}
