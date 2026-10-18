/** Deny by default: only these are public. /api/* is exempt from the redirect and must protect itself: its handlers (Task 5) are responsible for rejecting unauthenticated calls. */
export function routeAccess(pathname: string): 'public' | 'api' | 'gated' {
  if (pathname === '/signin' || pathname === '/waitlist' || pathname === '/favicon.ico') return 'public';
  if (pathname.startsWith('/auth/') || pathname.startsWith('/_next/')) return 'public';
  if (pathname.startsWith('/api/')) return 'api';
  return 'gated';
}
