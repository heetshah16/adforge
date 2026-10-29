import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDb } from '@adforge/db/client';
import { users } from '@adforge/db/schema';
import { provisionWith } from '../lib/server/provision-owner';
import { requireUserWith } from '../lib/server/session';

type Claims = { data: { claims: { sub: string; email?: string; app_metadata?: { provider?: string }; user_metadata?: { email_verified?: boolean } } } | null; error: Error | null };
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
  it('OAuth (discord) with an unverified email -> /signin, nothing provisioned, even for an admin email', async () => {
    const userId = randomUUID();
    const email = `boss-${userId}@example.test`;
    for (const user_metadata of [{ email_verified: false }, {}, undefined]) {
      const claims = { sub: userId, email, app_metadata: { provider: 'discord' }, user_metadata };
      await redirectsTo(requireUserWith({ supabase: fake({ data: { claims }, error: null }), provision: prov({ adminEmails: [email], prod: true }) }), '/signin');
    }
    expect(await h.db.select().from(users).where(eq(users.id, userId))).toHaveLength(0);
  });
  it('OAuth (discord) with a verified email passes the same invite gate; email-link users need no flag', async () => {
    const admin = randomUUID();
    const adminEmail = `boss-${admin}@example.test`;
    const claims = { sub: admin, email: adminEmail, app_metadata: { provider: 'discord' }, user_metadata: { email_verified: true } };
    expect(await requireUserWith({ supabase: fake({ data: { claims }, error: null }), provision: prov({ adminEmails: [adminEmail], prod: true }) })).toMatchObject({ userId: admin, isAdmin: true });
    const stranger = randomUUID();
    const strangerClaims = { ...claims, sub: stranger, email: `x-${stranger}@example.test` };
    await redirectsTo(requireUserWith({ supabase: fake({ data: { claims: strangerClaims }, error: null }), provision: prov({ adminEmails: [adminEmail], prod: true }) }), '/waitlist');
    const linkUser = randomUUID();
    const linkEmail = `boss-${linkUser}@example.test`;
    expect(await requireUserWith({ supabase: fake({ data: { claims: { sub: linkUser, email: linkEmail, app_metadata: { provider: 'email' } } }, error: null }), provision: prov({ adminEmails: [linkEmail], prod: true }) })).toMatchObject({ userId: linkUser });
  });
});
