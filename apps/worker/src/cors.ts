const jsonError = (error: string, status: number) => new Response(JSON.stringify({ error }), { status, headers: { 'content-type': 'application/json' } });

/** The UI (another origin) reads worker responses directly. Multipart and body-less POSTs are CORS "simple requests". */
export function withCors(r: Response, origin: string): Response {
  const headers = new Headers(r.headers);
  headers.set('access-control-allow-origin', origin);
  headers.set('vary', 'origin');
  return new Response(r.body, { status: r.status, statusText: r.statusText, headers });
}

/**
 * CORS only limits who can *read* a response, so a hostile page could still POST. Reject non-GET/HEAD requests whose Origin isn't the UI
 * (a missing Origin — curl, e2e — passes), and any Host that isn't loopback:port (DNS rebinding). Returns the 403, or null.
 */
export function guard(method: string | undefined, headers: Record<string, string | string[] | undefined>, port: number, uiOrigin: string): Response | null {
  if (headers.host !== `127.0.0.1:${port}` && headers.host !== `localhost:${port}`) return jsonError('host not allowed', 403);
  if (method !== 'GET' && method !== 'HEAD' && headers.origin !== undefined && headers.origin !== uiOrigin) return jsonError('origin not allowed', 403);
  return null;
}
