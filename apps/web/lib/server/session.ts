import { redirect } from 'next/navigation';
import { createSupabaseServer } from '../supabase/server';
import { ProvisionRefused, provisionCurrent } from './provision-owner';

export type SessionUser = { userId: string; email: string; isAdmin: boolean };
export type SessionDeps = {
  supabase: { auth: { getClaims(): Promise<{ data: { claims: { sub: string; email?: string } } | null; error: unknown }> } };
  provision: (u: { userId: string; email: string }) => Promise<{ isAdmin: boolean }>;
};

/** Verified identity (getClaims checks the JWT; never getSession) plus first-login provisioning. No valid claims -> /signin. */
export async function requireUser(): Promise<SessionUser> {
  return requireUserWith({ supabase: await createSupabaseServer(), provision: provisionCurrent });
}

/** Test seam. Not a server action: this module has no 'use server'. */
export async function requireUserWith({ supabase, provision }: SessionDeps): Promise<SessionUser> {
  const { data, error } = await supabase.auth.getClaims();
  const claims = data?.claims;
  if (error || !claims?.sub || !claims.email) redirect('/signin');
  const email = claims.email.toLowerCase();
  let isAdmin: boolean;
  try {
    ({ isAdmin } = await provision({ userId: claims.sub, email }));
  } catch (e) {
    if (e instanceof ProvisionRefused) redirect(e.reason === 'conflict' ? '/signin?error=conflict' : '/waitlist');
    throw e;
  }
  return { userId: claims.sub, email, isAdmin };
}
