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

type OAuth = { auth: { signInWithOAuth(a: { provider: 'discord'; options: { redirectTo: string; skipBrowserRedirect: boolean } }): Promise<{ data: { url: string | null }; error: { message: string } | null }> } };

/**
 * Discord sign-in start (ADR 0021). Returns Discord's authorize URL; the PKCE verifier cookie is set by the server client, and
 * /auth/confirm exchanges the returned ?code=. Who gets in is unchanged: provision gates on the (verified) email, as for links.
 */
export async function discordUrlWith(supabase: OAuth, env: { ADFORGE_SITE_URL: string }): Promise<string> {
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'discord',
    options: { redirectTo: new URL('/auth/confirm', env.ADFORGE_SITE_URL).href, skipBrowserRedirect: true },
  });
  if (error || !data.url) {
    console.warn('signInWithOAuth:', error?.message ?? 'no url');
    return '/signin?error=link';
  }
  return data.url;
}
