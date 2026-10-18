import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openPostgres, type Db } from '@adforge/db/client';
import { withUser } from '@adforge/db/with-user';
import { approveVariant, getJobView } from '../lib/data/jobs';
import { dropTenants, makeTenant, type Tenant } from './tenant-fixture';

// Needs real row locking: PGlite has one connection. Runs against the Supabase dev database via ADFORGE_TEST_DATABASE_URL.
describe.skipIf(!process.env.ADFORGE_TEST_DATABASE_URL)('approveVariant concurrency (postgres)', () => {
  let h: { db: Db; close(): Promise<void> };
  const made: Tenant[] = [];
  beforeAll(async () => { h = await openPostgres(process.env.ADFORGE_TEST_DATABASE_URL!, { migrate: false }); });
  afterAll(async () => { try { await dropTenants(h.db, made); } finally { await h.close(); } });

  it.each([1, 2, 3])('10 parallel approves on different variants -> exactly one approved (round %i)', async () => {
    const t = await makeTenant(h.db, Array(10).fill('completed'));
    made.push(t);
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => withUser(h.db, t.userId, (u) => approveVariant(u, t.jobId, i + 1))));
    expect(results).toEqual(Array(10).fill('ok'));
    const v = (await withUser(h.db, t.userId, (u) => getJobView(u, t.jobId, (k) => k)))!.variants;
    expect(v.filter((x) => x.status === 'approved')).toHaveLength(1);
    expect(v.filter((x) => x.status === 'completed')).toHaveLength(9);
  }, 60_000);
});
