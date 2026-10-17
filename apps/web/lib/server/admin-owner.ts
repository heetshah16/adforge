import { count, desc, eq, sql } from 'drizzle-orm';
import { createClient } from '@supabase/supabase-js';
import { memberships, orgs, waitlist } from '@adforge/db/schema';
import type { Db } from '@adforge/db/client';
import { getDb } from './db';
import { serverEnv } from './env';

export type WaitlistEntry = typeof waitlist.$inferSelect;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Owner-only: waitlist is admin-only under RLS and the callers have already checked `isAdmin`. */
export const listWaitlist = (db: Db) => db.select().from(waitlist).orderBy(desc(waitlist.createdAt));

export const listOrgsWithCounts = (db: Db) =>
  db
    .select({ id: orgs.id, name: orgs.name, createdAt: orgs.createdAt, members: count(memberships.userId) })
    .from(orgs)
    .leftJoin(memberships, eq(memberships.orgId, orgs.id))
    .groupBy(orgs.id)
    .orderBy(desc(orgs.createdAt));

/** A malformed id is just "not found" rather than a Postgres cast error. */
export async function getWaitlistEntry(db: Db, id: string): Promise<WaitlistEntry | undefined> {
  if (!UUID.test(id)) return undefined;
  return (await db.select().from(waitlist).where(eq(waitlist.id, id)))[0];
}

export const markInvited = (db: Db, id: string) =>
  db.update(waitlist).set({ status: 'invited', invitedAt: sql`now()` }).where(eq(waitlist.id, id)).then(() => undefined);

export const adminWaitlist = async () => listWaitlist(await getDb());
export const adminOrgs = async () => listOrgsWithCounts(await getDb());
export const adminGetWaitlistEntry = async (id: string) => getWaitlistEntry(await getDb(), id);
export const adminMarkInvited = async (id: string) => markInvited(await getDb(), id);

/** Supabase Auth admin API (secret key, server only). Throws on failure. */
export async function inviteByEmail(email: string, redirectTo: string): Promise<void> {
  const env = serverEnv();
  const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error } = await supabase.auth.admin.inviteUserByEmail(email, { redirectTo });
  if (error) throw error;
}
