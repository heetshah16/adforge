/** CSRF guard for state-changing routes: only our own origin (from ADFORGE_SITE_URL, never request headers) may call them. */
export const isSiteOrigin = (req: Request, siteUrl: string) => req.headers.get('origin') === new URL(siteUrl).origin;
