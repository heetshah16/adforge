import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { routeAccess } from './lib/route-access';

// Session refresh + deny-by-default gate: every path not listed public in lib/route-access.ts redirects to /signin without claims.
// /api/* is refreshed but never redirected: route handlers answer 401/404 themselves via requireUser.
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
    const redirect = NextResponse.redirect(new URL('/signin', request.url));
    for (const c of response.cookies.getAll()) redirect.cookies.set(c);
    return redirect;
  }
  return response;
}

export const config = {
  matcher: ['/((?!_next/|favicon.ico|auth/).*)'],
};
