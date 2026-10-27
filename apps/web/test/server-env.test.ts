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
const R2P = { ADFORGE_PROVIDER_STORAGE: 'r2', R2_ACCOUNT_ID: 'a'.repeat(32), R2_ACCESS_KEY_ID: 'AKID', R2_SECRET_ACCESS_KEY: 'SECRET', R2_BUCKET: 'adforge-media' };

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

describe('storage profile', () => {
  const PROD = { ...OK, ADFORGE_ENV: 'prod', ADFORGE_SITE_URL: 'https://app.example.com', INNGEST_EVENT_KEY: 'ek', INNGEST_SIGNING_KEY: 'sk' };
  it('prod must use r2', () => {
    expect(() => parseServerEnv({ ...PROD, ADFORGE_PROVIDER_STORAGE: 'local' })).toThrow(/ADFORGE_PROVIDER_STORAGE/);
  });
  it('r2 shape-checks R2_ACCOUNT_ID and R2_BUCKET and does not need ADFORGE_DATA_DIR', () => {
    expect(() => parseServerEnv({ ...OK, ...R2P, R2_ACCOUNT_ID: 'not-hex' })).toThrow(/R2_ACCOUNT_ID/);
    expect(() => parseServerEnv({ ...OK, ...R2P, R2_BUCKET: 'Bad_Bucket' })).toThrow(/R2_BUCKET/);
    const { ADFORGE_DATA_DIR: _, ...noDir } = OK;
    expect(parseServerEnv({ ...noDir, ...R2P }).ADFORGE_PROVIDER_STORAGE).toBe('r2');
  });
  it('r2 without R2_BUCKET names it', () => {
    const { R2_BUCKET: _, ...noBucket } = R2P;
    expect(() => parseServerEnv({ ...OK, ...noBucket })).toThrow(/R2_BUCKET/);
  });
  it('R2_TIMEOUT_MS defaults to 30000 and ADFORGE_MEDIA_TTL_SEC is range-checked', () => {
    const e = parseServerEnv({ ...OK, ...R2P });
    expect(e.R2_TIMEOUT_MS).toBe(30_000);
    expect(e.ADFORGE_MEDIA_TTL_SEC).toBe(900);
    expect(() => parseServerEnv({ ...OK, ADFORGE_MEDIA_TTL_SEC: '59' })).toThrow(/ADFORGE_MEDIA_TTL_SEC/);
    expect(() => parseServerEnv({ ...OK, ADFORGE_MEDIA_TTL_SEC: '3601' })).toThrow(/ADFORGE_MEDIA_TTL_SEC/);
  });
  it('local is the default and needs no R2 vars', () => {
    expect(parseServerEnv(OK).ADFORGE_PROVIDER_STORAGE).toBe('local');
  });
});

describe('ADFORGE_ENV / ADFORGE_SITE_URL', () => {
  it('unset env: production NODE_ENV fails closed to prod (and then needs a site url)', () => {
    expect(() => parseServerEnv({ ...OK, NODE_ENV: 'production' })).toThrow(/ADFORGE_SITE_URL/);
    expect(parseServerEnv({ ...OK, NODE_ENV: 'production', ADFORGE_SITE_URL: 'https://app.example.com', INNGEST_EVENT_KEY: 'ek', INNGEST_SIGNING_KEY: 'sk', ...R2P }).ADFORGE_ENV).toBe('prod');
  });
  it('unset env: non-production NODE_ENV is dev, site url defaults to localhost:3000', () => {
    for (const NODE_ENV of [undefined, 'development', 'test']) {
      const e = parseServerEnv({ ...OK, NODE_ENV });
      expect(e.ADFORGE_ENV).toBe('dev');
      expect(e.ADFORGE_SITE_URL).toBe('http://localhost:3000');
    }
  });
  it('prod requires INNGEST_EVENT_KEY and INNGEST_SIGNING_KEY; dev does not', () => {
    const prod = { ...OK, ...R2P, ADFORGE_ENV: 'prod', ADFORGE_SITE_URL: 'https://app.example.com' };
    expect(() => parseServerEnv(prod)).toThrow(/INNGEST_EVENT_KEY/);
    expect(() => parseServerEnv({ ...prod, INNGEST_EVENT_KEY: 'ek' })).toThrow(/INNGEST_SIGNING_KEY/); // serve() at /api/inngest verifies with it
    expect(parseServerEnv({ ...prod, INNGEST_EVENT_KEY: 'ek', INNGEST_SIGNING_KEY: 'sk' }).INNGEST_EVENT_KEY).toBe('ek');
    expect(parseServerEnv({ ...OK, ADFORGE_ENV: 'dev' }).ADFORGE_ENV).toBe('dev');
  });
  it('explicit ADFORGE_ENV wins', () => {
    expect(parseServerEnv({ ...OK, NODE_ENV: 'production', ADFORGE_ENV: 'dev' }).ADFORGE_ENV).toBe('dev');
  });
});
