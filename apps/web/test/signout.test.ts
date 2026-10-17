import { NextRequest } from 'next/server';
import { beforeAll, describe, expect, it, vi } from 'vitest';

const signOut = vi.fn(async () => ({ error: null }));
vi.mock('../lib/supabase/server', () => ({ createSupabaseServer: async () => ({ auth: { signOut } }) }));

let POST: typeof import('../app/auth/signout/route').POST;
beforeAll(async () => {
  Object.assign(process.env, {
    DATABASE_URL: 'postgresql://u:p@localhost:5432/postgres',
    NEXT_PUBLIC_SUPABASE_URL: 'https://x.supabase.co',
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'pk',
    SUPABASE_SECRET_KEY: 'sk',
    ADFORGE_DATA_DIR: 'C:/adforge-data',
    ADFORGE_PUBLIC_URL: 'http://127.0.0.1:3001',
    ADFORGE_SITE_URL: 'https://app.example.com',
  });
  ({ POST } = await import('../app/auth/signout/route'));
});

const req = (origin?: string) =>
  new NextRequest('http://internal.host/auth/signout', { method: 'POST', headers: origin ? { origin } : {} });

describe('POST /auth/signout', () => {
  it('foreign or missing Origin -> 403, session untouched', async () => {
    for (const o of ['https://evil.example', undefined]) {
      const r = await POST(req(o));
      expect(r.status).toBe(403);
    }
    expect(signOut).not.toHaveBeenCalled();
  });
  it('site Origin -> local sign-out and 303 to the configured site /signin', async () => {
    const r = await POST(req('https://app.example.com'));
    expect(r.status).toBe(303);
    expect(r.headers.get('location')).toBe('https://app.example.com/signin');
    expect(signOut).toHaveBeenCalledWith({ scope: 'local' });
  });
});
