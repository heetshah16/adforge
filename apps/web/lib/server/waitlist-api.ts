import { z } from 'zod';
import { rateLimit } from './rate-limit';
import { readTextCapped } from './read-capped';
import type { WaitlistRow } from './waitlist-owner';

/** Everything the waitlist route touches, injected so tests can run it on PGlite. */
export type WaitlistCtx = {
  insert(row: WaitlistRow): Promise<void>;
  rateLimit(key: string, limit: number, windowSec: number): Promise<boolean>;
};

const MAX_BODY = 8 * 1024;
const MIN_FILL_MS = 3000;

const WaitlistInput = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.email().max(254).transform((e) => e.toLowerCase()),
  brand: z.string().trim().min(1).max(120),
  website: z.url({ protocol: /^https?$/ }).max(300).optional(),
  category: z.string().trim().min(1).max(80),
  country: z.string().trim().min(1).max(80),
  note: z.string().trim().max(1000).optional(),
  company_url: z.string().optional(),
  startedAt: z.number().int().nonnegative(),
});

const json = (body: unknown, status = 200) => Response.json(body, { status });
const ok = () => json({ ok: true });

/**
 * Assumes platform-set headers: x-vercel-forwarded-for on Vercel, else x-real-ip, else the LAST x-forwarded-for entry
 * (the hop our own proxy appended). The first x-forwarded-for entry is client-controlled, so it is never used.
 */
export function clientIp(req: Request): string {
  const h = req.headers;
  const last = h.get('x-forwarded-for')?.split(',').pop()?.trim();
  return h.get('x-vercel-forwarded-for')?.trim() || h.get('x-real-ip')?.trim() || last || 'unknown';
}

export async function waitlistHandler(ctx: WaitlistCtx, req: Request): Promise<Response> {
  // Counted before anything else, so every attempt draws on the budget, not only the ones that validate.
  if (!(await ctx.rateLimit(`waitlist:${clientIp(req)}`, 5, 600))) return json({ error: 'too many requests' }, 429);
  const text = await readTextCapped(req, MAX_BODY);
  if (text === null) return json({ error: 'body larger than 8 KB' }, 413);
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return json({ error: 'expected JSON' }, 400); }
  // Bot signals first, so a bot gets the same silent 200 whatever else is wrong with its payload.
  const signals = raw && typeof raw === 'object' ? (raw as { company_url?: unknown; startedAt?: unknown }) : {};
  if (signals.company_url) return ok();
  if (typeof signals.startedAt === 'number' && Date.now() - signals.startedAt < MIN_FILL_MS) return ok();
  const parsed = WaitlistInput.safeParse(raw);
  if (!parsed.success) return json({ error: 'invalid', issues: z.flattenError(parsed.error).fieldErrors }, 400);
  const { startedAt, company_url, ...f } = parsed.data;
  await ctx.insert(f);
  return ok();
}
