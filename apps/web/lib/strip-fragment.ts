/** Invite links land on /signin#access_token=…; we never consume the fragment, so drop it from the address bar and history. */
export function stripTokenFragment(loc: Pick<Location, 'hash' | 'pathname' | 'search'>, replace: (url: string) => void) {
  if (loc.hash.includes('access_token')) replace(loc.pathname + loc.search);
}
