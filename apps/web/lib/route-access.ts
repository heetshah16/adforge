/** Deny by default: only these are public. /api/* is not redirected (route handlers answer 401/404 themselves via requireUser). */
export function routeAccess(pathname: string): 'public' | 'api' | 'gated' {
  if (pathname === '/signin' || pathname === '/waitlist' || pathname === '/favicon.ico') return 'public';
  if (pathname.startsWith('/auth/') || pathname.startsWith('/_next/')) return 'public';
  if (pathname.startsWith('/api/')) return 'api';
  return 'gated';
}
