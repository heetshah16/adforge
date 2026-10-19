import { and, eq } from 'drizzle-orm';
import { memberships } from '@adforge/db/schema';
import type { UserDb } from '@adforge/db/with-user';
import { orgKey, parseKey } from '@adforge/core/providers/storage-key';
import type { SessionUser } from './session';

export type MediaCtx = {
  auth(): Promise<SessionUser | Response>;
  run<T>(userId: string, fn: (udb: UserDb) => Promise<T>): Promise<T>;
  /** true = r2 profile (the only one that serves /media). */
  r2: boolean;
  ttlSec: number;
  presignGet(key: string, ttlSec: number, opts?: { download?: boolean }): Promise<string>;
};

const json = (body: unknown, status: number) => Response.json(body, { status });

/** GET /media/<key>: members of the key's org get a 302 to a short-lived signed R2 GET. No URL is minted for anyone else. */
export async function mediaHandler(ctx: MediaCtx, keyParts: string[], download = false): Promise<Response> {
  if (!ctx.r2) return json({ error: 'not found' }, 404);
  const user = await ctx.auth();
  if (user instanceof Response) return user;
  const key = keyParts.join('/');
  const k = parseKey(key);
  if (!k || k.org === null || key !== orgKey(k.org, k.sha, k.ext)) return json({ error: 'not found' }, 404);
  const org = k.org;
  const member = await ctx.run(user.userId, async (udb) =>
    (await udb.select({ o: memberships.orgId }).from(memberships).where(and(eq(memberships.orgId, org), eq(memberships.userId, user.userId))).limit(1)).length > 0);
  if (!member) return json({ error: 'forbidden' }, 403);
  const url = await ctx.presignGet(key, ctx.ttlSec, { download });
  return new Response(null, { status: 302, headers: { location: url, 'cache-control': `private, max-age=${ctx.ttlSec - 60}` } });
}
