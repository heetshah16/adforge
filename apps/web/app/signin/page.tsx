import { redirect } from 'next/navigation';
import { createSupabaseServer } from '@/lib/supabase/server';
import { serverEnv } from '@/lib/server/env';
import { sendLinkWith } from '@/lib/server/signin';

async function sendLink(form: FormData) {
  'use server';
  redirect(await sendLinkWith(await createSupabaseServer(), serverEnv(), String(form.get('email') ?? '')));
}

export default async function SignIn({ searchParams }: { searchParams: Promise<{ sent?: string; error?: string }> }) {
  const q = await searchParams;
  return (
    <>
      <h1>Sign in</h1>
      {q.sent ? (
        <p>If this address can sign in, a link is on its way. Asked recently? Wait a minute and try again.</p>
      ) : (
        <form action={sendLink}>
          <label>Email<input name="email" type="email" required autoComplete="email" /></label>
          {q.error === 'link' && <p className="errors" role="alert">That link is invalid or expired. Request a new one.</p>}
          {q.error === 'conflict' && <p className="errors" role="alert">Account conflict — ask the admin.</p>}
          {q.error === 'email' && <p className="errors" role="alert">Enter a valid email.</p>}
          <button type="submit">Email me a sign-in link</button>
        </form>
      )}
    </>
  );
}
