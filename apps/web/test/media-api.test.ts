import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDb } from '@adforge/db/client';
import { withUser } from '@adforge/db/with-user';
import { orgKey } from '@adforge/core/providers/storage-key';
import { mediaHandler, type MediaCtx } from '../lib/server/media-api';
import { dropTenants, makeTenant, type Tenant } from './tenant-fixture';

const SHA = 'ab'.repeat(32);
const get = (key: string) => mediaHandler(ctxFor(a), key.split('/'));
let h: Awaited<ReturnType<typeof openDb>>;
let a: Tenant;
let b: Tenant;
const minted: string[] = [];
const ctxFor = (t: Tenant | null, over: Partial<MediaCtx> = {}): MediaCtx => ({
  auth: async () => (t ? { userId: t.userId, email: 'x@y.z', isAdmin: false, orgId: t.orgId } : Response.json({ error: 'unauthenticated' }, { status: 401 })),
  run: (userId, fn) => withUser(h.db, userId, fn),
  r2: true,
  ttlSec: 900,
  presignGet: async (k, ttl, o) => { minted.push(k); return `https://r2.test/${k}?ttl=${ttl}${o?.download ? '&dl=1' : ''}`; },
  ...over,
});

describe('GET /media/[...key]', () => {
  beforeAll(async () => { h = await openDb(); a = await makeTenant(h.db); b = await makeTenant(h.db); });
  afterAll(async () => { await dropTenants(h.db, [a, b]); await h.close(); });

  it('401 no session; 404 bad key; 403 key of an org the caller is not a member of', async () => {
    minted.length = 0;
    expect((await mediaHandler(ctxFor(null), orgKey(a.orgId, SHA, 'mp4').split('/'))).status).toBe(401);
    for (const k of [['nope'], ['org', a.orgId, 'cd', `${SHA}.mp4`], [`ab`, `${SHA}.png`], ['org', a.orgId, 'ab', '..', `${SHA}.mp4`]]) {
      expect((await mediaHandler(ctxFor(a), k)).status).toBe(404);
    }
    const r = await mediaHandler(ctxFor(a), orgKey(b.orgId, SHA, 'mp4').split('/'));
    expect(r.status).toBe(403);
    expect(r.headers.get('location')).toBeNull();
    expect(minted).toEqual([]);
  });

  it('302 to the signed URL with the TTL and private cache header for an own-org key', async () => {
    const key = orgKey(a.orgId, SHA, 'mp4');
    const r = await get(key);
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe(`https://r2.test/${key}?ttl=900`);
    expect(r.headers.get('cache-control')).toBe('private, max-age=840');
  });

  it('download=1 is forwarded to the signer', async () => {
    const key = orgKey(a.orgId, SHA, 'mp4');
    const r = await mediaHandler(ctxFor(a), key.split('/'), true);
    expect(r.headers.get('location')).toBe(`https://r2.test/${key}?ttl=900&dl=1`);
  });

  it('a user in two orgs can read both (membership of the key org, not user.orgId)', async () => {
    const { memberships } = await import('@adforge/db/schema');
    await h.db.insert(memberships).values({ orgId: b.orgId, userId: a.userId, role: 'member' });
    expect((await get(orgKey(b.orgId, SHA, 'mp4'))).status).toBe(302);
  });

  it('404 in the dev (local) profile', async () => {
    const r = await mediaHandler(ctxFor(a, { r2: false }), orgKey(a.orgId, SHA, 'mp4').split('/'));
    expect(r.status).toBe(404);
  });
});
