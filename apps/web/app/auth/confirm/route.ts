import type { EmailOtpType } from '@supabase/supabase-js';
import { NextResponse, type NextRequest } from 'next/server';
import { serverEnv } from '../../../lib/server/env';
import { createSupabaseServer } from '../../../lib/supabase/server';

const TYPES: EmailOtpType[] = ['email', 'magiclink', 'invite', 'signup'];

export async function GET(request: NextRequest) {
  const site = serverEnv().ADFORGE_SITE_URL;
  // OAuth (Discord) refused by Supabase because the provider email is unverified: say so instead of the generic error.
  if (/unverified email/i.test(request.nextUrl.searchParams.get('error_description') ?? '')) return NextResponse.redirect(new URL('/signin?error=unverified', site));
  const code = request.nextUrl.searchParams.get('code');
  // Default mailer: sign-in links are PKCE (`?code=`), the verifier cookie was set by the same browser's signInWithOtp.
  if (code) {
    const supabase = await createSupabaseServer();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(new URL('/', site));
    return NextResponse.redirect(new URL('/signin?error=link', site));
  }
  const token_hash = request.nextUrl.searchParams.get('token_hash');
  const type = request.nextUrl.searchParams.get('type') as EmailOtpType | null;
  if (token_hash && type && TYPES.includes(type)) {
    const supabase = await createSupabaseServer();
    const { error } = await supabase.auth.verifyOtp({ token_hash, type });
    if (!error) return NextResponse.redirect(new URL('/', site));
  }
  return NextResponse.redirect(new URL('/signin?error=link', site));
}
