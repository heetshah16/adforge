import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDb } from '@adforge/db/client';
import { users } from '@adforge/db/schema';
import { requireUser } from '../lib/server/session';

type Claims = { data: { claims: { sub: string; email?: string } } | null; error: Error | null };
const fake = (r: Claims) => ({ auth: { getClaims: async () => r } });

describe('requireUser', () => {
  let h: Awaited<ReturnType<typeof openDb>>;
  beforeAll(async () => { h = await openDb(); });
  afterAll(() => h.close());
  const redirected = (p: Promise<unknown>) => expect(p).rejects.toMatchObject({ digest: expect.stringContaining('NEXT_REDIRECT;replace;/signin') });

  it('no claims -> redirect /signin', async () => {
    await redirected(requireUser({ supabase: fake({ data: null, error: null }), db: h.db, adminEmails: [] }));
  });
  it('tampered cookie (getClaims errors) -> redirect /signin', async () => {
    await redirected(requireUser({ supabase: fake({ data: null, error: new Error('bad jwt') }), db: h.db, adminEmails: [] }));
  });
  it('valid claims -> user, provisioned, admin flag from env list', async () => {
    const userId = randomUUID();
    const email = `Boss-${userId}@Example.test`;
    const u = await requireUser({ supabase: fake({ data: { claims: { sub: userId, email } }, error: null }), db: h.db, adminEmails: [email.toLowerCase()] });
    expect(u).toEqual({ userId, email: email.toLowerCase(), isAdmin: true });
    expect(await h.db.select().from(users).where(eq(users.id, userId))).toHaveLength(1);
  });
});
