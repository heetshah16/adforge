/** Not a 'use server' module: the action in app/signin/page.tsx calls this and redirects to the returned path. */
type Otp = { auth: { signInWithOtp(a: { email: string; options: { emailRedirectTo: string; shouldCreateUser: boolean } }): Promise<{ error: { message: string } | null }> } };

/**
 * Every outcome after a syntactically valid email (success, any error, any 429) returns the same path: Supabase rate-limits
 * and rejects only some addresses, so any distinguishable result would reveal which emails are accounts.
 */
export async function sendLinkWith(
  supabase: Otp,
  env: { ADFORGE_ENV: 'dev' | 'prod'; ADFORGE_ADMIN_EMAILS: string[]; ADFORGE_SITE_URL: string },
  rawEmail: string,
): Promise<'/signin?sent=1' | '/signin?error=email'> {
  const email = rawEmail.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) return '/signin?error=email';
  // Prod: only admins may create an account here; everyone else must have been invited (provision re-checks server-side).
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: new URL('/auth/confirm', env.ADFORGE_SITE_URL).href, shouldCreateUser: env.ADFORGE_ENV === 'dev' || env.ADFORGE_ADMIN_EMAILS.includes(email) },
  });
  if (error) console.warn('signInWithOtp:', error.message);
  return '/signin?sent=1';
}
