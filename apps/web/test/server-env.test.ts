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
