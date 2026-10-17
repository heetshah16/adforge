import { redirect } from 'next/navigation';
import type { Db } from '@adforge/db/client';
import { createSupabaseServer } from '../supabase/server';
import { getDb } from './db';
import { serverEnv } from './env';
import { provision } from './provision-owner';

export type SessionUser = { userId: string; email: string; isAdmin: boolean };
type Deps = {
  supabase: { auth: { getClaims(): Promise<{ data: { claims: { sub: string; email?: string } } | null; error: unknown }> } };
  db: Db;
  adminEmails: string[];
};

/** Verified identity (getClaims checks the JWT; never getSession) plus first-login provisioning. No valid claims -> /signin. */
export async function requireUser(deps?: Deps): Promise<SessionUser> {
  const { supabase, db, adminEmails } = deps ?? { supabase: await createSupabaseServer(), db: await getDb(), adminEmails: serverEnv().ADFORGE_ADMIN_EMAILS };
  const { data, error } = await supabase.auth.getClaims();
  const claims = data?.claims;
  if (error || !claims?.sub || !claims.email) redirect('/signin');
  const email = claims.email.toLowerCase();
  await provision(db, { userId: claims.sub, email, adminEmails });
  return { userId: claims.sub, email, isAdmin: adminEmails.includes(email) };
}
