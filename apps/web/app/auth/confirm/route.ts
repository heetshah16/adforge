import type { EmailOtpType } from '@supabase/supabase-js';
import { NextResponse, type NextRequest } from 'next/server';
import { createSupabaseServer } from '@/lib/supabase/server';

const TYPES: EmailOtpType[] = ['email', 'magiclink', 'invite', 'signup'];

export async function GET(request: NextRequest) {
  const token_hash = request.nextUrl.searchParams.get('token_hash');
  const type = request.nextUrl.searchParams.get('type') as EmailOtpType | null;
  if (token_hash && type && TYPES.includes(type)) {
    const supabase = await createSupabaseServer();
    const { error } = await supabase.auth.verifyOtp({ token_hash, type });
    if (!error) return NextResponse.redirect(new URL('/', request.url));
  }
  return NextResponse.redirect(new URL('/signin?error=link', request.url));
}
