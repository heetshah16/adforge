import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { createSupabaseServer } from '@/lib/supabase/server';
import { serverEnv } from '@/lib/server/env';

async function sendLink(form: FormData) {
  'use server';
  const email = String(form.get('email') ?? '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) redirect('/signin?error=email');
  const env = serverEnv();
  const origin = (await headers()).get('origin') ?? 'http://localhost:3000';
  const supabase = await createSupabaseServer();
  // Prod: only admins may create an account here; everyone else must have been invited. Same response either way (no enumeration).
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: `${origin}/auth/confirm`, shouldCreateUser: env.ADFORGE_ENV === 'dev' || env.ADFORGE_ADMIN_EMAILS.includes(email) },
  });
  if (error) console.warn('signInWithOtp:', error.message);
  redirect('/signin?sent=1');
}

export default async function SignIn({ searchParams }: { searchParams: Promise<{ sent?: string; error?: string }> }) {
  const q = await searchParams;
  return (
    <>
      <h1>Sign in</h1>
      {q.sent ? (
        <p>Check your email for a sign-in link.</p>
      ) : (
        <form action={sendLink}>
          <label>Email<input name="email" type="email" required autoComplete="email" /></label>
          {q.error === 'link' && <p className="errors" role="alert">That link is invalid or expired. Request a new one.</p>}
          {q.error === 'email' && <p className="errors" role="alert">Enter a valid email.</p>}
          <button type="submit">Email me a sign-in link</button>
        </form>
      )}
    </>
  );
}
