import { randomUUID } from 'node:crypto';
import { getTableColumns, getTableName, is, sql } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/client';
import * as schema from '../src/schema';
import { withUser } from '../src/with-user';

const url = process.env.ADFORGE_TEST_DATABASE_URL;

/** Tables without org_id. Each is covered by its own policy; adding a table means adding it here or giving it org_id. */
const NON_TENANT = ['users', 'orgs', 'memberships', 'waitlist', 'vocab_families', 'archetypes', 'formats', 'hook_archetypes'];
/** Every org_id table, in creation order (parents first). The coverage test fails if the schema gains one not listed. */
const TENANT = ['projects', 'products', 'assets', 'jobs', 'variants', 'provider_calls'] as const;
type Tenant = (typeof TENANT)[number];
type Fixture = { org: string; user: string } & Record<Tenant, string>;

/** What a member writes directly (migration 0009); everything else is the worker's, on the owner connection. */
const INSERTABLE: readonly Tenant[] = ['projects', 'products', 'assets', 'jobs'];
const UPDATABLE: Partial<Record<Tenant, string>> = { projects: 'name', products: 'name', variants: 'status' };
/** authenticated's exact privileges per public table; column-level UPDATE shown as UPDATE(cols). */
const PRIVILEGES: Record<string, string[]> = {
  projects: ['SELECT', 'INSERT', 'UPDATE(brand_kit,name)'],
  products: ['SELECT', 'INSERT', 'UPDATE(name)'],
  assets: ['SELECT', 'INSERT'],
  jobs: ['SELECT', 'INSERT'],
  variants: ['SELECT', 'UPDATE(status)'],
  provider_calls: ['SELECT'],
  orgs: ['SELECT'],
  memberships: ['SELECT'],
  users: ['SELECT'],
  waitlist: ['SELECT', 'UPDATE'],
  vocab_families: ['SELECT'],
  archetypes: ['SELECT'],
  formats: ['SELECT'],
  hook_archetypes: ['SELECT'],
};

/** PGlite returns { rows }, postgres-js returns the row array directly. */
function rows<T>(r: unknown): T[] {
  return (Array.isArray(r) ? r : (r as { rows: T[] }).rows) as T[];
}
function code(e: unknown): string | undefined {
  return (e as { cause?: { code?: string } }).cause?.code ?? (e as { code?: string }).code;
}
/** Rows returned, or 'denied' for insufficient_privilege (42501, which RLS violations also raise). Anything else rethrows. */
async function affected(p: Promise<unknown>): Promise<number | 'denied'> {
  try {
    return rows(await p).length;
  } catch (e) {
    if (code(e) === '42501') return 'denied';
    throw e;
  }
}
async function errorCode(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (e) {
    return code(e);
  }
  return 'no error';
}

let variantNo = 0;
/** One row per tenant table, parents taken from `f`, so a mixed fixture exercises the composite FKs. */
const ROW: Record<Tenant, (db: Db, f: Fixture, id: string) => Promise<unknown>> = {
  projects: (db, f, id) => db.insert(schema.projects).values({ id, orgId: f.org, userId: f.user, name: 'rls' }),
  products: (db, f, id) => db.insert(schema.products).values({ id, orgId: f.org, projectId: f.projects, name: 'rls' }),
  assets: (db, f, id) =>
    db.insert(schema.assets).values({ id, orgId: f.org, projectId: f.projects, kind: 'render', storageKey: id, mime: 'video/mp4', bytes: 1, sha256: id }),
  jobs: (db, f, id) => db.insert(schema.jobs).values({ id, orgId: f.org, projectId: f.projects, userId: f.user, inputSpec: {} }),
  variants: (db, f, id) =>
    db.insert(schema.variants).values({
      id, orgId: f.org, jobId: f.jobs, variantNo: ++variantNo, formatSlug: 'f', hookSlug: 'h', archetypeSlug: 'a',
      visualTreatment: 't', strategicBet: 'b', renderAssetId: f.assets,
    }),
  provider_calls: (db, f, id) =>
    db.insert(schema.providerCalls).values({
      id, orgId: f.org, jobId: f.jobs, variantId: f.variants, kind: 'render', provider: 'fake', requestHash: 'h', idempotencyKey: id,
    }),
};

async function makeOrg(db: Db): Promise<Fixture> {
  const f = { org: randomUUID(), user: randomUUID() } as Fixture;
  for (const t of TENANT) f[t] = randomUUID();
  await db.insert(schema.orgs).values({ id: f.org, name: `rls-${f.org}` });
  await db.insert(schema.users).values({ id: f.user, email: `${f.user}@rls.test` });
  await db.insert(schema.memberships).values({ orgId: f.org, userId: f.user, role: 'owner' });
  for (const t of TENANT) await ROW[t](db, f, f[t]);
  return f;
}

/**
 * PGlite always; Postgres when ADFORGE_TEST_DATABASE_URL is set (migrated by global-setup.ts).
 * Postgres runs on one connection, so "nothing leaks past the transaction" is checked on the connection withUser used.
 */
const backends: [string, () => Promise<{ db: Db; close(): Promise<void> }>][] = [['pglite', () => openDb()]];
if (url) {
  backends.push(['postgres', async () => {
    const client = postgres(url, { prepare: false, max: 1 });
    return { db: drizzle({ client, schema, casing: 'snake_case' }), close: () => client.end({ timeout: 5 }) };
  }]);
}

describe.each(backends)('RLS on %s', (_name, open) => {
  let db: Db;
  let close: () => Promise<void>;
  let a: Fixture;
  let b: Fixture;
  const admin = randomUUID();
  const waitlistId = randomUUID();

  beforeAll(async () => {
    ({ db, close } = await open());
    a = await makeOrg(db);
    b = await makeOrg(db);
    await db.insert(schema.users).values({ id: admin, email: `${admin}@rls.test`, isAdmin: true });
    await db.insert(schema.waitlist).values({ id: waitlistId, name: 'n', email: `${waitlistId}@rls.test`, brand: 'b', category: 'c', country: 'IN' });
  });

  afterAll(async () => {
    if (!db) return;
    try {
      const orgIds = [a?.org, b?.org].filter(Boolean) as string[];
      for (const t of [...TENANT].reverse()) {
        if (orgIds.length) await db.execute(sql`delete from ${sql.identifier(t)} where org_id in ${orgIds}`);
      }
      if (orgIds.length) await db.execute(sql`delete from memberships where org_id in ${orgIds}`);
      await db.execute(sql`delete from waitlist where id = ${waitlistId}`);
      await db.execute(sql`delete from users where id in ${[a?.user, b?.user, admin].filter(Boolean) as string[]}`);
      if (orgIds.length) await db.execute(sql`delete from orgs where id in ${orgIds}`);
    } finally {
      await close();
    }
  });

  it('every table has RLS; every org_id table has policies; every other table is allowlisted; anon holds no grant', async () => {
    const dbTables = rows<{ name: string; rls: boolean; policies: number }>(await db.execute(sql`
      select c.relname as name, c.relrowsecurity as rls,
        (select count(*) from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname)::int as policies
      from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
    `));
    const byName = new Map(dbTables.map((r) => [r.name, r]));
    const tables = Object.values(schema as Record<string, unknown>).filter((x): x is PgTable => is(x, PgTable));
    expect(tables.length).toBeGreaterThan(0);
    for (const t of tables) {
      const name = getTableName(t);
      const r = byName.get(name);
      expect(r?.rls, `${name} has RLS`).toBe(true);
      if ('orgId' in getTableColumns(t)) expect(r!.policies, `${name} has policies`).toBeGreaterThan(0);
      else expect(NON_TENANT, `${name} has no org_id`).toContain(name);
    }
    // A new org_id table must join TENANT, which gives it the per-table behaviour tests below.
    // memberships is the exception: it is the tenancy link itself, policied per user (tested further down).
    const orgTables = tables.filter((t) => 'orgId' in getTableColumns(t)).map(getTableName).filter((n) => n !== 'memberships');
    expect(orgTables.sort()).toEqual([...TENANT].sort());
    // Tables created outside the Drizzle schema are covered too.
    expect(dbTables.filter((r) => !r.rls).map((r) => r.name)).toEqual([]);
    // anon holds nothing at all.
    const anon = rows<{ name: string }>(await db.execute(sql`
      select relname as name from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r'
        and has_table_privilege('anon', oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    `));
    expect(anon).toEqual([]);
    // authenticated holds exactly PRIVILEGES. TRUNCATE (and TRIGGER/REFERENCES) bypass RLS, so they would show up here.
    const privs = rows<{ name: string; privs: string[] }>(await db.execute(sql`
      select c.relname as name, array_remove(array[
        case when has_table_privilege('authenticated', c.oid, 'SELECT') then 'SELECT' end,
        case when has_table_privilege('authenticated', c.oid, 'INSERT') then 'INSERT' end,
        case when has_table_privilege('authenticated', c.oid, 'UPDATE') then 'UPDATE' end,
        case when has_table_privilege('authenticated', c.oid, 'DELETE') then 'DELETE' end,
        case when has_table_privilege('authenticated', c.oid, 'TRUNCATE,REFERENCES,TRIGGER') then 'TRUNCATE/REFERENCES/TRIGGER' end,
        case when not has_table_privilege('authenticated', c.oid, 'UPDATE') and has_any_column_privilege('authenticated', c.oid, 'UPDATE')
          then 'UPDATE(' || (select string_agg(a.attname::text, ',' order by a.attname) from pg_attribute a
            where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
              and has_column_privilege('authenticated', c.oid, a.attnum, 'UPDATE')) || ')' end
      ], null) as privs
      from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
    `));
    expect(Object.fromEntries(privs.map((r) => [r.name, r.privs]))).toEqual(PRIVILEGES);
  });

  for (const t of TENANT) {
    describe(t, () => {
      const T = sql.identifier(t);

      it(`a member of A sees A's row and none of B's`, async () => {
        expect(await affected(withUser(db, a.user, (u) => u.execute(sql`select id from ${T} where id = ${a[t]}`)))).toBe(1);
        expect(await affected(withUser(db, a.user, (u) => u.execute(sql`select id from ${T} where org_id = ${b.org}`)))).toBe(0);
      });

      const update = (id: string, column: string) => withUser(db, a.user, (u) =>
        u.execute(sql`update ${T} set ${sql.identifier(column)} = ${sql.identifier(column)} where id = ${id} returning id`));

      it(`a member of A updates and deletes 0 of B's rows, and never moves a row between orgs`, async () => {
        const col = UPDATABLE[t];
        if (col) {
          expect(await affected(update(b[t], col))).toBe(0); // granted, so RLS is what filters it
          expect(await affected(update(a[t], col))).toBe(1);
        }
        expect(await affected(update(b[t], 'org_id'))).toBe('denied');
        expect(await affected(update(a[t], 'org_id'))).toBe('denied');
        const del = withUser(db, a.user, (u) => u.execute(sql`delete from ${T} where id = ${b[t]} returning id`));
        expect(await affected(del)).toBe('denied');
        expect(await affected(db.execute(sql`select id from ${T} where id = ${b[t]}`))).toBe(1); // still there
      });

      it(`a member of A cannot insert a row with org_id = B`, async () => {
        // B's own parents, so only RLS can refuse it.
        expect(await errorCode(withUser(db, a.user, (u) => ROW[t](u, { ...b, user: a.user }, randomUUID())))).toBe('42501');
        const own = withUser(db, a.user, (u) => ROW[t](u, a, randomUUID()));
        if (INSERTABLE.includes(t)) await own;
        else expect(await errorCode(own)).toBe('42501'); // written by the worker only
      });

      if (t !== 'projects') {
        it(`a row in org A cannot reference org B's parents (composite FK, even for the owner)`, async () => {
          expect(await errorCode(ROW[t](db, { ...b, org: a.org, user: a.user }, randomUUID()))).toBe('23503');
        });
      }
    });
  }

  it('a member sees only their own org, membership and user row; registry is read-only', async () => {
    await withUser(db, a.user, async (u) => {
      expect(rows<{ id: string }>(await u.execute(sql`select id from orgs`)).map((r) => r.id)).toEqual([a.org]);
      expect(rows<{ org_id: string }>(await u.execute(sql`select org_id from memberships`)).map((r) => r.org_id)).toEqual([a.org]);
      expect(rows<{ id: string }>(await u.execute(sql`select id from users`)).map((r) => r.id)).toEqual([a.user]);
      for (const r of ['vocab_families', 'archetypes', 'formats', 'hook_archetypes']) await u.execute(sql`select 1 from ${sql.identifier(r)} limit 1`);
    });
    const ins = withUser(db, a.user, (u) => u.execute(sql`insert into vocab_families (kind, slug, name) values ('hook', ${randomUUID()}, 'x')`));
    expect(await errorCode(ins)).toBe('42501');
  });

  it('waitlist: a non-admin sees and updates nothing; an admin sees and updates everything', async () => {
    const all = rows(await db.execute(sql`select id from waitlist`)).length;
    expect(await affected(withUser(db, a.user, (u) => u.execute(sql`select id from waitlist`)))).toBe(0);
    expect(await affected(withUser(db, a.user, (u) => u.execute(sql`update waitlist set note = 'x' where id = ${waitlistId} returning id`)))).toBe(0);
    expect(await affected(withUser(db, admin, (u) => u.execute(sql`select id from waitlist`)))).toBe(all);
    expect(await affected(withUser(db, admin, (u) => u.execute(sql`update waitlist set note = 'x' where id = ${waitlistId} returning id`)))).toBe(1);
  });

  it('anon reads nothing from any tenant table or the waitlist', async () => {
    for (const t of [...TENANT, 'waitlist']) {
      const r = db.transaction(async (tx) => {
        await tx.execute(sql`set local role anon`);
        return tx.execute(sql`select id from ${sql.identifier(t)}`);
      });
      expect([0, 'denied'], t).toContain(await affected(r));
    }
  });

  it('withUser leaks nothing past its transaction, even when fn throws', async () => {
    const [owner] = rows<{ u: string }>(await db.execute(sql`select current_user as u`));
    const inside = await withUser(db, a.user, async (u) =>
      rows<{ u: string; uid: string }>(await u.execute(sql`select current_user as u, auth.uid() as uid`))[0]);
    expect(inside).toEqual({ u: 'authenticated', uid: a.user });
    await expect(withUser(db, a.user, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    const [after] = rows<{ u: string; claims: string | null; sub: string | null }>(await db.execute(sql`
      select current_user as u, nullif(current_setting('request.jwt.claims', true), '') as claims,
        nullif(current_setting('request.jwt.claim.sub', true), '') as sub
    `));
    expect(after).toEqual({ u: owner!.u, claims: null, sub: null });
  });

  it('withUser refuses to run inside a transaction: SET LOCAL would outlive the savepoint', async () => {
    const nested = withUser(db, a.user, (u) =>
      // @ts-expect-error a UserDb is not a Db
      withUser(u, b.user, async () => 'ran as B'));
    await expect(nested).rejects.toThrow('withUser must not be nested in a transaction');
    const inTx = db.transaction((tx) =>
      // @ts-expect-error a transaction is not a Db
      withUser(tx, a.user, async () => 'ran as A'));
    await expect(inTx).rejects.toThrow('withUser must not be nested in a transaction');
  });
});
