import { NextRequest } from 'next/server';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const exchangeCodeForSession = vi.fn();
const verifyOtp = vi.fn();
vi.mock('../lib/supabase/server', () => ({ createSupabaseServer: async () => ({ auth: { exchangeCodeForSession, verifyOtp } }) }));

let GET: typeof import('../app/auth/confirm/route').GET;
let SignIn: typeof import('../app/signin/page').default;
const savedEnv = { ...process.env };
afterAll(() => {
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
});
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
  ({ GET } = await import('../app/auth/confirm/route'));
  SignIn = (await import('../app/signin/page')).default;
});
beforeEach(() => {
  exchangeCodeForSession.mockReset();
  verifyOtp.mockReset();
});

const get = async (qs: string) => (await GET(new NextRequest(`http://internal.host/auth/confirm?${qs}`))).headers.get('location');

describe('GET /auth/confirm', () => {
  it('code: exchange success -> /', async () => {
    exchangeCodeForSession.mockResolvedValue({ error: null });
    expect(await get('code=abc')).toBe('https://app.example.com/');
    expect(exchangeCodeForSession).toHaveBeenCalledWith('abc');
  });
  it('code: exchange error -> /signin?error=link', async () => {
    exchangeCodeForSession.mockResolvedValue({ error: { message: 'bad' } });
    expect(await get('code=abc')).toBe('https://app.example.com/signin?error=link');
  });
  it('token_hash path still verifies', async () => {
    verifyOtp.mockResolvedValue({ error: null });
    expect(await get('token_hash=h&type=email')).toBe('https://app.example.com/');
    expect(verifyOtp).toHaveBeenCalledWith({ token_hash: 'h', type: 'email' });
    expect(exchangeCodeForSession).not.toHaveBeenCalled();
  });
  it('neither param -> error', async () => {
    expect(await get('')).toBe('https://app.example.com/signin?error=link');
  });
});

describe('/signin invited copy', () => {
  const html = async (sp: object) => renderToStaticMarkup(await SignIn({ searchParams: Promise.resolve(sp) }));
  it('shows the invite line only when invited=1', async () => {
    expect(await html({ invited: '1' })).toContain('You&#x27;re invited — enter your email to get a sign-in link.');
    expect(await html({})).not.toContain('invited');
  });
});
