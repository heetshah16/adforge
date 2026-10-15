import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import * as schema from './schema';

const MIGRATIONS = fileURLToPath(new URL('../drizzle', import.meta.url));

function makeDb(client: PGlite) {
  return drizzle({ client, schema, casing: 'snake_case' });
}
export type Db = ReturnType<typeof makeDb>;

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
 * ponytail: pid lockfile, not an OS lock — a reused pid can block until the file is deleted by hand.
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
          `Lock file ${lockPath} is unreadable or corrupt — delete it if no other AdForge process is running.`,
        );
      }
      if (isAlive(pid)) {
        throw new Error(`Database ${dataDir} is already open by pid ${pid}. Stop that process first.`);
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
        await client.close();
        release();
      },
    };
  } catch (e) {
    release();
    throw e;
  }
}
