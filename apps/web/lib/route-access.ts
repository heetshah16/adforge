/** Deny by default: only these are public. /api/* and /media/* are exempt from the redirect and must protect itself: their handlers are responsible for rejecting unauthenticated calls (a media element wants a 401, not a sign-in page). */
export function routeAccess(pathname: string): 'public' | 'api' | 'gated' {
  if (pathname === '/signin' || pathname === '/waitlist' || pathname === '/favicon.ico') return 'public';
  if (pathname.startsWith('/auth/') || pathname.startsWith('/_next/')) return 'public';
  if (pathname.startsWith('/api/') || pathname.startsWith('/media/')) return 'api';
  return 'gated';
}
