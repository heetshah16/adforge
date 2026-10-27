import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { drizzle as drizzlePg } from 'drizzle-orm/postgres-js';
import { migrate as migratePg } from 'drizzle-orm/postgres-js/migrator';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import postgres from 'postgres';
import type { Env } from '@adforge/core/config/env';
import * as schema from './schema';

const MIGRATIONS = join(fileURLToPath(import.meta.url), '..', '..', 'drizzle');

function makeDb(client: PGlite) {
  return drizzle({ client, schema, casing: 'snake_case' });
}
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * PGlite is single-process: two writers on one directory corrupt it.
 * The lock is created atomically WITH its pid (temp file + hard link), so a reader never sees it empty.
 * ponytail: pid lockfile, not an OS lock - a reused pid can block until the file is deleted by hand.
 */
function acquireLock(dataDir: string): () => void {
  mkdirSync(dataDir, { recursive: true });
  const lockPath = join(dataDir, '.adforge.lock');
  const tmp = `${lockPath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, String(process.pid), { flag: 'wx' });
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        linkSync(tmp, lockPath); // EEXIST if held
        return () => rmSync(lockPath, { force: true });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      }
      let text: string;
      try {
        text = readFileSync(lockPath, 'utf8');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue; // released meanwhile
        throw e;
      }
      const pid = Number(text);
      if (!/^\d+$/.test(text.trim()) || !Number.isSafeInteger(pid) || pid <= 0) {
        throw new Error(
          `Lock file ${lockPath} is unreadable or corrupt - delete it if no other AdForge process is running.`,
        );
      }
      if (isAlive(pid)) {
        throw new Error(`Database ${dataDir} is already open by pid ${pid}. If pid ${pid} is not an AdForge process, delete ${lockPath}.`);
      }
      // Stale: rename is atomic, so only one reclaimer wins; losers get ENOENT and retry the link.
      const stale = `${lockPath}.stale.${randomUUID()}`;
      try {
        renameSync(lockPath, stale);
        rmSync(stale, { force: true });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
    }
    throw new Error(`Could not acquire lock on ${dataDir}`);
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** `dataDir` undefined = in-memory (tests). Applies all migrations before returning. */
export async function openDb(dataDir?: string): Promise<{ db: Db; close(): Promise<void> }> {
  const release = dataDir ? acquireLock(dataDir) : () => {};
  try {
    const client = new PGlite(dataDir ? join(dataDir, 'pg') : undefined);
    const db = makeDb(client);
    try {
      await migrate(db, { migrationsFolder: MIGRATIONS });
    } catch (e) {
      await client.close();
      throw e;
    }
    return {
      db,
      async close() {
        try {
          await client.close();
        } finally {
          release();
        }
      },
    };
  } catch (e) {
    release();
    throw e;
  }
}

/** Per-statement cap for request-path transactions (withUser sets it with SET LOCAL). */
export const STATEMENT_TIMEOUT_MS = 15_000;

/**
 * postgres-js options. `prepare: false` for Supabase's transaction pooler (:6543). No `connection: { statement_timeout }`:
 * that is a startup parameter and session state, which Supavisor transaction mode does not honour (docs/providers/vercel.md).
 */
export function pgOptions(opts: { connectTimeoutSec?: number } = {}) {
  return { prepare: false, max: 5, connect_timeout: opts.connectTimeoutSec ?? 10 } as const satisfies postgres.Options<{}>;
}

/** Applies migrations before returning unless `migrate: false` (the web app). `prepare: false` keeps it working behind Supabase's transaction pooler. */
export async function openPostgres(url: string, opts: { connectTimeoutSec?: number; migrate?: boolean } = {}): Promise<{ db: Db; close(): Promise<void> }> {
  const client = postgres(url, pgOptions(opts));
  const db = drizzlePg({ client, schema, casing: 'snake_case' });
  try {
    if (opts.migrate ?? true) await migratePg(db, { migrationsFolder: MIGRATIONS });
  } catch (e) {
    await client.end();
    throw e;
  }
  return { db, close: () => client.end({ timeout: 5 }) };
}

/** Postgres whenever DATABASE_URL is set (dev or prod); otherwise PGlite under the data dir (dev only - Env requires the URL in prod). */
export function openDbForEnv(env: Pick<Env, 'ADFORGE_ENV' | 'ADFORGE_DATA_DIR' | 'DATABASE_URL'>): Promise<{ db: Db; close(): Promise<void> }> {
  if (env.DATABASE_URL) return openPostgres(env.DATABASE_URL);
  if (env.ADFORGE_ENV === 'prod') throw new Error('DATABASE_URL is required when ADFORGE_ENV=prod');
  return openDb(env.ADFORGE_DATA_DIR);
}
