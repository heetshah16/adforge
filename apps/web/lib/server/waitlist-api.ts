import { z } from 'zod';
import { rateLimit } from './rate-limit';
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
  company_url: z.string().max(300).optional(),
  startedAt: z.number().int().nonnegative(),
});

const json = (body: unknown, status = 200) => Response.json(body, { status });
const ok = () => json({ ok: true });

/** Reads at most MAX_BODY bytes, whether or not Content-Length was declared. Null = too large. */
async function readCapped(req: Request): Promise<string | null> {
  if (Number(req.headers.get('content-length') ?? 0) > MAX_BODY) return null;
  if (!req.body) return '';
  const reader = req.body.getReader();
  const dec = new TextDecoder();
  let text = '';
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY) {
      await reader.cancel();
      return null;
    }
    text += dec.decode(value, { stream: true });
  }
  return text + dec.decode();
}

/** The client IP is the first x-forwarded-for entry, else x-real-ip. */
export function clientIp(req: Request): string {
  const fwd = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return fwd || req.headers.get('x-real-ip')?.trim() || 'unknown';
}

export async function waitlistHandler(ctx: WaitlistCtx, req: Request): Promise<Response> {
  // Counted before anything else, so every attempt draws on the budget, not only the ones that validate.
  if (!(await ctx.rateLimit(`waitlist:${clientIp(req)}`, 5, 600))) return json({ error: 'too many requests' }, 429);
  const text = await readCapped(req);
  if (text === null) return json({ error: 'body larger than 8 KB' }, 413);
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return json({ error: 'expected JSON' }, 400); }
  const parsed = WaitlistInput.safeParse(raw);
  if (!parsed.success) return json({ error: 'invalid', issues: z.flattenError(parsed.error).fieldErrors }, 400);
  const { startedAt, company_url, ...f } = parsed.data;
  // Bots get the same 200 as a real signup, so they cannot tell the checks apart.
  if (company_url) return ok();
  if (Date.now() - startedAt < MIN_FILL_MS) return ok();
  await ctx.insert(f);
  return ok();
}
