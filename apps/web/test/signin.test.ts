import { describe, expect, it, vi } from 'vitest';
import { sendLinkWith } from '../lib/server/signin';

const env = { ADFORGE_ENV: 'prod' as const, ADFORGE_ADMIN_EMAILS: ['a@x.io'], ADFORGE_SITE_URL: 'https://app.example.com' };
const client = (error: unknown) => ({ auth: { signInWithOtp: vi.fn(async (_a: { options: { emailRedirectTo: string; shouldCreateUser: boolean } }) => ({ error: error as { message: string } | null })) } });

describe('sendLinkWith', () => {
  it('success, 429 and otp_disabled give the identical outcome (no enumeration)', async () => {
    const outcomes = await Promise.all([
      sendLinkWith(client(null), env, 'u@x.io'),
      sendLinkWith(client({ message: 'rate', code: 'over_email_send_rate_limit', status: 429 }), env, 'u@x.io'),
      sendLinkWith(client({ message: 'Signups not allowed for otp', code: 'otp_disabled', status: 422 }), env, 'u@x.io'),
    ]);
    expect(new Set(outcomes)).toEqual(new Set(['/signin?sent=1']));
  });
  it('uses the configured site url and only lets admins create accounts in prod', async () => {
    const c = client(null);
    await sendLinkWith(c, env, ' A@x.io ');
    await sendLinkWith(c, env, 'u@x.io');
    expect(c.auth.signInWithOtp.mock.calls.map((x) => [x[0].options.emailRedirectTo, x[0].options.shouldCreateUser])).toEqual([
      ['https://app.example.com/auth/confirm', true],
      ['https://app.example.com/auth/confirm', false],
    ]);
  });
  it('rejects a malformed email', async () => {
    expect(await sendLinkWith(client(null), env, 'nope')).toBe('/signin?error=email');
  });
});
