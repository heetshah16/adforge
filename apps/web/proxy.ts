import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

// Session refresh + optimistic gate (the pages are client components, so there is no server page to call requireUser from).
// Verification of record is getClaims(); API routes verify again with requireUser.
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
  const { pathname } = request.nextUrl;
  const protectedPath = pathname === '/' || pathname.startsWith('/jobs');
  if (protectedPath && !data?.claims) {
    const redirect = NextResponse.redirect(new URL('/signin', request.url));
    for (const c of response.cookies.getAll()) redirect.cookies.set(c);
    return redirect;
  }
  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|auth/|api/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js)$).*)'],
};
