import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/client';
import * as schema from '../src/schema';
import { assets, memberships, orgs, projects, users } from '../src/schema';
import { OPERATOR_ORG_ID, seedOperator } from '../src/seed/seed';

const MIGRATIONS = fileURLToPath(new URL('../drizzle', import.meta.url));
const TENANT_TABLES = ['projects', 'assets', 'jobs', 'variants', 'provider_calls'] as const;

/** A copy of the migrations folder that stops at 0002 — the last pre-tenancy (POC) schema. */
function preTenancyMigrations(): string {
  const dir = mkdtempSync(join(tmpdir(), 'adforge-mig-'));
  cpSync(MIGRATIONS, dir, { recursive: true });
  const path = join(dir, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(path, 'utf8')) as { entries: { idx: number }[] };
  journal.entries = journal.entries.filter((e) => e.idx <= 2);
  writeFileSync(path, JSON.stringify(journal));
  return dir;
}

describe('tenancy migrations', () => {
  it('backfill every pre-existing POC row into the Operator org', async () => {
    const pre = preTenancyMigrations();
    const client = new PGlite();
    try {
      const db = drizzle({ client, schema, casing: 'snake_case' });
      await migrate(db, { migrationsFolder: pre });
      // POC rows, written against the pre-tenancy schema.
      await client.exec(`
        insert into users (id, email) values ('11111111-1111-4111-8111-111111111111', 'local@adforge.dev');
        insert into projects (id, user_id, name) values ('22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111', 'Local');
        insert into assets (id, project_id, kind, storage_key, mime, bytes, sha256)
          values ('33333333-3333-4333-8333-333333333333', '22222222-2222-4222-8222-222222222222', 'render', 'k', 'video/mp4', 1, 'abc');
        insert into jobs (id, project_id, user_id, input_spec)
          values ('44444444-4444-4444-8444-444444444444', '22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111', '{}');
        insert into variants (id, job_id, variant_no, format_slug, hook_slug, archetype_slug, visual_treatment, strategic_bet, render_asset_id)
          values ('55555555-5555-4555-8555-555555555555', '44444444-4444-4444-8444-444444444444', 1, 'f', 'h', 'a', 't', 'b', '33333333-3333-4333-8333-333333333333');
        insert into provider_calls (job_id, variant_id, kind, provider, request_hash, idempotency_key)
          values ('44444444-4444-4444-8444-444444444444', '55555555-5555-4555-8555-555555555555', 'render', 'fake', 'h', 'k1');
      `);
      await migrate(db, { migrationsFolder: MIGRATIONS });
      for (const t of TENANT_TABLES) {
        const { rows } = await client.query<{ org_id: string | null }>(`select org_id from ${t}`);
        expect(rows, t).toEqual([{ org_id: OPERATOR_ORG_ID }]);
      }
      const { rows } = await client.query<{ name: string }>(`select name from orgs`);
      expect(rows).toEqual([{ name: 'Operator' }]);
      // The backfilled local user/project are the ones seedOperator hands to dev scripts.
      expect(await seedOperator(db)).toEqual({
        orgId: OPERATOR_ORG_ID, userId: '11111111-1111-4111-8111-111111111111', projectId: '22222222-2222-4222-8222-222222222222',
      });
    } finally {
      await client.close();
      rmSync(pre, { recursive: true, force: true });
    }
  });

  it('a fresh database gets exactly one Operator org and no NULL org_id is possible', async () => {
    const { db, close } = await openDb();
    try {
      expect(await db.select({ id: orgs.id, name: orgs.name }).from(orgs)).toEqual([{ id: OPERATOR_ORG_ID, name: 'Operator' }]);
      const { userId } = await seedOperator(db);
      await expect(db.execute(`insert into projects (user_id, name) values ('${userId}', 'x')`)).rejects.toMatchObject({
        cause: { message: expect.stringMatching(/null value in column "org_id"/) },
      });
    } finally {
      await close();
    }
  });

  it('dedupes assets per org, not per project', async () => {
    const { db, close } = await openDb();
    try {
      const op = await seedOperator(db);
      const [b] = await db.insert(orgs).values({ name: 'B' }).returning();
      const [pb] = await db.insert(projects).values({ orgId: b!.id, userId: op.userId, name: 'b' }).returning();
      const [p2] = await db.insert(projects).values({ orgId: op.orgId, userId: op.userId, name: 'second' }).returning();
      const row = { kind: 'upload', storageKey: 'k', mime: 'image/png', bytes: 1, sha256: 'same' };
      await db.insert(assets).values({ ...row, orgId: op.orgId, projectId: op.projectId });
      await db.insert(assets).values({ ...row, orgId: b!.id, projectId: pb!.id }); // another org: fine
      await expect(db.insert(assets).values({ ...row, orgId: op.orgId, projectId: p2!.id })).rejects.toMatchObject({
        cause: { message: expect.stringMatching(/duplicate key.*assets_orgId_sha256_unique/) },
      });
      expect(await db.$count(assets)).toBe(2);
    } finally {
      await close();
    }
  });
});

describe('seedOperator', () => {
  it('is idempotent: same ids, one org, one owner membership, one user, one project', async () => {
    const { db, close } = await openDb();
    try {
      const a = await seedOperator(db);
      const b = await seedOperator(db);
      expect(b).toEqual(a);
      expect(a.orgId).toBe(OPERATOR_ORG_ID);
      expect(await db.$count(orgs)).toBe(1);
      expect(await db.$count(users)).toBe(1);
      expect(await db.$count(projects)).toBe(1);
      expect(await db.select().from(memberships)).toMatchObject([{ orgId: a.orgId, userId: a.userId, role: 'owner' }]);
    } finally {
      await close();
    }
  });
});
