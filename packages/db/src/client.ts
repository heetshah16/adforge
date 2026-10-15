import { mkdirSync, openSync, readFileSync, rmSync, writeSync, closeSync } from 'node:fs';
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
 * ponytail: pid lockfile, not an OS lock — a reused pid can block until the file is deleted by hand.
 */
function acquireLock(dataDir: string): () => void {
  mkdirSync(dataDir, { recursive: true });
  const lockPath = join(dataDir, '.adforge.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, 'wx');
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return () => rmSync(lockPath, { force: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const pid = Number(readFileSync(lockPath, 'utf8'));
      if (Number.isInteger(pid) && isAlive(pid)) {
        throw new Error(`Database ${dataDir} is already open by pid ${pid}. Stop that process first.`);
      }
      rmSync(lockPath, { force: true }); // stale lock from a dead process
    }
  }
  throw new Error(`Could not acquire lock on ${dataDir}`);
}

/** `dataDir` undefined = in-memory (tests). Applies all migrations before returning. */
export async function openDb(dataDir?: string): Promise<{ db: Db; close(): Promise<void> }> {
  const release = dataDir ? acquireLock(dataDir) : () => {};
  try {
    const client = new PGlite(dataDir ? join(dataDir, 'pg') : undefined);
    const db = makeDb(client);
    await migrate(db, { migrationsFolder: MIGRATIONS });
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
