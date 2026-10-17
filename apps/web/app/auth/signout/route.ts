import { NextResponse, type NextRequest } from 'next/server';
import { createSupabaseServer } from '@/lib/supabase/server';

export async function POST(request: NextRequest) {
  await (await createSupabaseServer()).auth.signOut();
  return NextResponse.redirect(new URL('/signin', request.url), 303);
}
