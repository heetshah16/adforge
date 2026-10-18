import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDb } from '@adforge/db/client';
import { users } from '@adforge/db/schema';
import { provisionWith } from '../lib/server/provision-owner';
import { requireUserWith } from '../lib/server/session';

type Claims = { data: { claims: { sub: string; email?: string } } | null; error: Error | null };
const fake = (r: Claims) => ({ auth: { getClaims: async () => r } });

describe('requireUserWith', () => {
  let h: Awaited<ReturnType<typeof openDb>>;
  beforeAll(async () => { h = await openDb(); });
  afterAll(() => h.close());
  const prov = (cfg: { adminEmails: string[]; prod: boolean }) => (u: { userId: string; email: string }) => provisionWith(h.db, u, cfg);
  const redirectsTo = (p: Promise<unknown>, to: string) => expect(p).rejects.toMatchObject({ digest: expect.stringContaining(`NEXT_REDIRECT;replace;${to};`) });

  it('no claims -> redirect /signin', async () => {
    await redirectsTo(requireUserWith({ supabase: fake({ data: null, error: null }), provision: prov({ adminEmails: [], prod: false }) }), '/signin');
  });
  it('tampered cookie (getClaims errors) -> redirect /signin', async () => {
    await redirectsTo(requireUserWith({ supabase: fake({ data: null, error: new Error('bad jwt') }), provision: prov({ adminEmails: [], prod: false }) }), '/signin');
  });
  it('claims with a sub but no email -> redirect /signin, nothing provisioned', async () => {
    const userId = randomUUID();
    await redirectsTo(requireUserWith({ supabase: fake({ data: { claims: { sub: userId } }, error: null }), provision: prov({ adminEmails: [], prod: false }) }), '/signin');
    expect(await h.db.select().from(users).where(eq(users.id, userId))).toHaveLength(0);
  });
  it('valid claims -> user, provisioned, admin flag from the config list', async () => {
    const userId = randomUUID();
    const email = `Boss-${userId}@Example.test`;
    const u = await requireUserWith({ supabase: fake({ data: { claims: { sub: userId, email } }, error: null }), provision: prov({ adminEmails: [email.toLowerCase()], prod: false }) });
    expect(u).toEqual({ userId, email: email.toLowerCase(), isAdmin: true, orgId: expect.any(String) });
    expect(await h.db.select().from(users).where(eq(users.id, userId))).toHaveLength(1);
  });
  it('prod, uninvited -> redirect /waitlist; email owned by another id -> /signin?error=conflict', async () => {
    const userId = randomUUID();
    const email = `x-${userId}@example.test`;
    await redirectsTo(requireUserWith({ supabase: fake({ data: { claims: { sub: userId, email } }, error: null }), provision: prov({ adminEmails: [], prod: true }) }), '/waitlist');
    await provisionWith(h.db, { userId: randomUUID(), email }, { adminEmails: [], prod: false });
    await redirectsTo(requireUserWith({ supabase: fake({ data: { claims: { sub: userId, email } }, error: null }), provision: prov({ adminEmails: [], prod: false }) }), '/signin?error=conflict');
  });
});
