import { z } from 'zod';
import { isSiteOrigin } from './origin';
import type { SessionUser } from './session';
import type { WaitlistEntry } from './admin-owner';

/** Everything the invite route touches, injected so tests can run it on PGlite with a fake Supabase client. */
export type AdminCtx = {
  requireUser(): Promise<SessionUser | Response>;
  siteUrl: string;
  get(id: string): Promise<WaitlistEntry | undefined>;
  markInvited(id: string): Promise<void>;
  invite(email: string, redirectTo: string): Promise<void>;
};

const Body = z.object({ waitlistId: z.string().min(1).max(64) });
const json = (body: unknown, status = 200) => Response.json(body, { status });

export async function inviteHandler(ctx: AdminCtx, req: Request): Promise<Response> {
  const user = await ctx.requireUser();
  if (user instanceof Response) return user;
  if (!user.isAdmin) return json({ error: 'not found' }, 404);
  // CSRF: state-changing, so only our own origin may call it.
  if (!isSiteOrigin(req, ctx.siteUrl)) return json({ error: 'forbidden' }, 403);
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: 'invalid' }, 400);
  const entry = await ctx.get(parsed.data.waitlistId);
  if (!entry) return json({ error: 'not found' }, 404);
  if (entry.status !== 'new') return json({ ok: true, status: entry.status });
  // The email is a courtesy (ADR 0021): invitees sign in with Discord, so a mailer failure (Supabase's built-in mailer is
  // rate-limited) must not block the invite. The waitlist status is what the provision gate reads.
  let emailSent = true;
  try {
    await ctx.invite(entry.email, new URL('/signin?invited=1', ctx.siteUrl).toString());
  } catch (e) {
    console.warn('inviteUserByEmail:', (e as Error).message);
    emailSent = false;
  }
  try {
    await ctx.markInvited(entry.id);
  } catch (e) {
    console.error(`markInvited failed (waitlist ${entry.id}, email sent: ${emailSent}):`, e);
    return json({ error: 'status update failed' }, 500);
  }
  return json({ ok: true, status: 'invited', emailSent });
}
