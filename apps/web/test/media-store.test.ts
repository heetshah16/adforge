import { describe, expect, it } from 'vitest';
import { parseServerEnv } from '../lib/server/env';
import { mediaStore } from '../lib/server/storage';

const BASE = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/postgres', NEXT_PUBLIC_SUPABASE_URL: 'https://x.supabase.co',
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'pk', SUPABASE_SECRET_KEY: 'sk', ADFORGE_PUBLIC_URL: 'http://127.0.0.1:3001',
  ADFORGE_SITE_URL: 'https://app.example.com', ADFORGE_PROVIDER_STORAGE: 'r2', R2_ACCOUNT_ID: 'a'.repeat(32),
  R2_ACCESS_KEY_ID: 'AKID', R2_SECRET_ACCESS_KEY: 'SECRET', R2_BUCKET: 'adforge-media',
};
const KEY = `org/0a1b2c3d-0000-4000-8000-00000000000a/ab/${'c'.repeat(62)}ab.png`.replace(`${'c'.repeat(62)}ab`, 'ab' + 'c'.repeat(62));

describe('mediaStore', () => {
  it('under r2, media URLs are built from the site origin, not the worker URL', () => {
    const url = mediaStore(parseServerEnv(BASE)).urlFor(KEY);
    expect(url).toBe(`https://app.example.com/media/${KEY}`);
  });
});
