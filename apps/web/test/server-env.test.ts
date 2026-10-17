import { describe, expect, it } from 'vitest';
import { parseServerEnv } from '../lib/server/env';

const OK = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/postgres',
  NEXT_PUBLIC_SUPABASE_URL: 'https://x.supabase.co',
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'pk',
  SUPABASE_SECRET_KEY: 'sk',
  ADFORGE_ADMIN_EMAILS: ' Heet@Example.com, b@x.io ,',
  ADFORGE_DATA_DIR: 'C:/adforge-data',
  ADFORGE_PUBLIC_URL: 'http://127.0.0.1:3001',
};

describe('parseServerEnv', () => {
  it('normalizes admin emails', () => {
    expect(parseServerEnv(OK).ADFORGE_ADMIN_EMAILS).toEqual(['heet@example.com', 'b@x.io']);
  });
  it('optional keys may be absent', () => {
    const e = parseServerEnv(OK);
    expect(e.INNGEST_EVENT_KEY).toBeUndefined();
    expect(e.INNGEST_DEV).toBeUndefined();
  });
  it.each(['DATABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_SECRET_KEY', 'ADFORGE_DATA_DIR', 'ADFORGE_PUBLIC_URL'])('missing %s names it', (k) => {
    const { [k]: _, ...rest } = OK as Record<string, string>;
    expect(() => parseServerEnv(rest)).toThrow(new RegExp(k));
  });
});

describe('ADFORGE_ENV / ADFORGE_SITE_URL', () => {
  it('unset env: production NODE_ENV fails closed to prod (and then needs a site url)', () => {
    expect(() => parseServerEnv({ ...OK, NODE_ENV: 'production' })).toThrow(/ADFORGE_SITE_URL/);
    expect(parseServerEnv({ ...OK, NODE_ENV: 'production', ADFORGE_SITE_URL: 'https://app.example.com' }).ADFORGE_ENV).toBe('prod');
  });
  it('unset env: non-production NODE_ENV is dev, site url defaults to localhost:3000', () => {
    for (const NODE_ENV of [undefined, 'development', 'test']) {
      const e = parseServerEnv({ ...OK, NODE_ENV });
      expect(e.ADFORGE_ENV).toBe('dev');
      expect(e.ADFORGE_SITE_URL).toBe('http://localhost:3000');
    }
  });
  it('explicit ADFORGE_ENV wins', () => {
    expect(parseServerEnv({ ...OK, NODE_ENV: 'production', ADFORGE_ENV: 'dev' }).ADFORGE_ENV).toBe('dev');
  });
});
