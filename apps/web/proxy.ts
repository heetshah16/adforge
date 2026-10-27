import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { routeAccess } from './lib/route-access';
import { serverEnv } from './lib/server/env';

// Session refresh + deny-by-default gate: every path not listed public in lib/route-access.ts redirects to /signin without claims.
// /api/* and /media/* are refreshed but never redirected; their route handlers must authenticate themselves.
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });
  const supabase = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll(list, headers) {
        for (const { name, value } of list) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of list) response.cookies.set(name, value, options);
        for (const [k, v] of Object.entries(headers)) response.headers.set(k, v);
      },
    },
  });
  const { data } = await supabase.auth.getClaims();
  if (routeAccess(request.nextUrl.pathname) === 'gated' && !data?.claims) {
    const redirect = NextResponse.redirect(new URL('/signin', serverEnv().ADFORGE_SITE_URL));
    for (const c of response.cookies.getAll()) redirect.cookies.set(c);
    return redirect;
  }
  return response;
}

export const config = {
  // api/inngest: Inngest's signed calls carry no session, so they skip the Supabase refresh (the route still classifies as 'api').
  matcher: ['/((?!_next/|favicon\\.ico$|auth/|api/inngest$).*)'],
};
