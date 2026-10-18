import { NextResponse, type NextRequest } from 'next/server';
import { isSiteOrigin } from '../../../lib/server/origin';
import { serverEnv } from '../../../lib/server/env';
import { createSupabaseServer } from '../../../lib/supabase/server';

export async function POST(request: NextRequest) {
  const site = serverEnv().ADFORGE_SITE_URL;
  // CSRF: a cross-site form post must not sign the user out.
  if (!isSiteOrigin(request, site)) return new NextResponse(null, { status: 403 });
  await (await createSupabaseServer()).auth.signOut({ scope: 'local' });
  return NextResponse.redirect(new URL('/signin', site), 303);
}
