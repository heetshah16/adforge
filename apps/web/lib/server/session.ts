import { redirect } from 'next/navigation';
import { createSupabaseServer } from '../supabase/server';
import { ProvisionRefused, provisionCurrent } from './provision-owner';

export type SessionUser = { userId: string; email: string; isAdmin: boolean; orgId: string };
export type SessionDeps = {
  supabase: { auth: { getClaims(): Promise<{ data: { claims: { sub: string; email?: string } } | null; error: unknown }> } };
  provision: (u: { userId: string; email: string }) => Promise<{ isAdmin: boolean; orgId: string }>;
};

/** Verified identity (getClaims checks the JWT; never getSession) plus first-login provisioning. No valid claims -> /signin. */
export async function requireUser(): Promise<SessionUser> {
  return requireUserWith({ supabase: await createSupabaseServer(), provision: provisionCurrent });
}

/** Test seam. Not a server action: this module has no 'use server'. */
export async function requireUserWith(deps: SessionDeps): Promise<SessionUser> {
  const r = await authenticate(deps);
  if ('user' in r) return r.user;
  redirect(r.refusal === 'signin' ? '/signin' : r.refusal === 'conflict' ? '/signin?error=conflict' : '/waitlist');
}

/** For route handlers: JSON 401 (no/forged session) / 403 (not invited) / 409 (email conflict) instead of a redirect. Same provisioning and invite gate. */
export async function requireApiUser(): Promise<SessionUser | Response> {
  return requireApiUserWith({ supabase: await createSupabaseServer(), provision: provisionCurrent });
}

export async function requireApiUserWith(deps: SessionDeps): Promise<SessionUser | Response> {
  const r = await authenticate(deps);
  if ('user' in r) return r.user;
  const [status, error] = r.refusal === 'signin' ? [401, 'unauthenticated'] : r.refusal === 'conflict' ? [409, 'account conflict'] : [403, 'not invited'];
  return Response.json({ error }, { status });
}

async function authenticate({ supabase, provision }: SessionDeps): Promise<{ user: SessionUser } | { refusal: 'signin' | 'conflict' | 'not-invited' }> {
  const { data, error } = await supabase.auth.getClaims();
  const claims = data?.claims;
  if (error || !claims?.sub || !claims.email) return { refusal: 'signin' };
  const email = claims.email.toLowerCase();
  try {
    const { isAdmin, orgId } = await provision({ userId: claims.sub, email });
    return { user: { userId: claims.sub, email, isAdmin, orgId } };
  } catch (e) {
    if (e instanceof ProvisionRefused) return { refusal: e.reason };
    throw e;
  }
}
