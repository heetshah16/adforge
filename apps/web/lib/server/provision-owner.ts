import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import type { Db } from '@adforge/db/client';
import { memberships, orgs, users, waitlist } from '@adforge/db/schema';
import { getDb } from './db';
import { serverEnv } from './env';

/** not-invited: prod, no invite/admin/membership. conflict: another auth user already owns this email. Nothing is written in either case. */
export class ProvisionRefused extends Error {
  constructor(readonly reason: 'not-invited' | 'conflict') {
    super(`provision refused: ${reason}`);
  }
}

/** The only entry point for app code: admin list and prod switch come from the server env, never from the caller. */
export async function provisionCurrent(p: { userId: string; email: string }): Promise<{ orgId: string; isAdmin: boolean }> {
  const env = serverEnv();
  return provisionWith(await getDb(), p, { adminEmails: env.ADFORGE_ADMIN_EMAILS, prod: env.ADFORGE_ENV === 'prod' });
}

/**
 * First-login provisioning (owner connection: RLS cannot bootstrap its own tenancy). Internal seam: tests inject the db and config.
 * Idempotent and concurrency-safe: the users upsert row-locks until commit, so a parallel call blocks there, then sees the membership the first one made.
 * Prod gate: a new org is created only for an admin, an invited/joined waitlist email, or a user who already has a membership.
 */
export function provisionWith(
  db: Db,
  p: { userId: string; email: string },
  cfg: { adminEmails: string[]; prod: boolean },
): Promise<{ orgId: string; isAdmin: boolean }> {
  const email = p.email.toLowerCase();
  const isAdmin = cfg.adminEmails.includes(email);
  return db.transaction(async (tx) => {
    const [clash] = await tx.select({ id: users.id }).from(users).where(and(eq(users.email, email), ne(users.id, p.userId))).limit(1);
    if (clash) throw new ProvisionRefused('conflict');
    if (cfg.prod && !isAdmin) {
      const [member] = await tx.select({ orgId: memberships.orgId }).from(memberships).where(eq(memberships.userId, p.userId)).limit(1);
      const [invite] = await tx
        .select({ id: waitlist.id })
        .from(waitlist)
        .where(and(sql`lower(${waitlist.email}) = ${email}`, inArray(waitlist.status, ['invited', 'joined'])))
        .limit(1);
      if (!member && !invite) throw new ProvisionRefused('not-invited');
    }
    await tx.insert(users).values({ id: p.userId, email, isAdmin }).onConflictDoUpdate({ target: users.id, set: { email, isAdmin } });
    const [m] = await tx.select({ orgId: memberships.orgId }).from(memberships).where(eq(memberships.userId, p.userId)).orderBy(memberships.createdAt).limit(1);
    let orgId = m?.orgId;
    if (!orgId) {
      const [o] = await tx.insert(orgs).values({ name: email.split('@')[0]! }).returning({ id: orgs.id });
      orgId = o!.id;
      await tx.insert(memberships).values({ orgId, userId: p.userId, role: 'owner' });
    }
    await tx.update(waitlist).set({ status: 'joined' }).where(and(sql`lower(${waitlist.email}) = ${email}`, ne(waitlist.status, 'joined')));
    return { orgId, isAdmin };
  });
}
