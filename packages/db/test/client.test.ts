import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb, openDbForEnv, type Db } from '../src/client';
import * as schema from '../src/schema';
import { jobs, projects, providerCalls, users } from '../src/schema';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function seedJob() {
  const { db, close } = await openDb();
  const [u] = await db.insert(users).values({ email: 't@x.dev' }).returning();
  const [p] = await db.insert(projects).values({ userId: u!.id, name: 'p' }).returning();
  const [j] = await db.insert(jobs).values({ projectId: p!.id, userId: u!.id, inputSpec: {} }).returning();
  return { db, close, jobId: j!.id };
}

describe('openDb', () => {
  it('migrates an in-memory database', async () => {
    const { db, close, jobId } = await seedJob();
    const rows = await db.select().from(jobs);
    expect(rows[0]?.id).toBe(jobId);
    expect(rows[0]?.status).toBe('queued');
    await close();
  });

  it('enforces the provider_calls idempotency key', async () => {
    const { db, close, jobId } = await seedJob();
    const call = { jobId, kind: 'image', provider: 'comfyui', requestHash: 'h', idempotencyKey: 'k1' };
    await db.insert(providerCalls).values(call);
    await expect(db.insert(providerCalls).values(call)).rejects.toMatchObject({ cause: { message: expect.stringMatching(/duplicate key.*provider_calls_idempotencyKey_unique/) } });
    await close();
  });

  it('refuses to open the same data dir twice', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adforge-db-'));
    dirs.push(dir);
    const first = await openDb(dir);
    await expect(openDb(dir)).rejects.toThrow(/already open by pid/);
    await first.close();
    const again = await openDb(dir); // lock released on close
    await again.close();
  });

  it('reclaims a lock left by a dead pid', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adforge-db-'));
    dirs.push(dir);
    writeFileSync(join(dir, '.adforge.lock'), String(spawnSync(process.execPath, ['-e', '']).pid));
    const db = await openDb(dir);
    await db.close();
  });

  it('refuses a corrupt lock without deleting it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adforge-db-'));
    dirs.push(dir);
    const lock = join(dir, '.adforge.lock');
    writeFileSync(lock, 'garbage');
    await expect(openDb(dir)).rejects.toThrow(/unreadable or corrupt/);
    expect(existsSync(lock)).toBe(true);
  });
});

describe('openDbForEnv', () => {
  it('dev opens PGlite under the data dir and takes the lock', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adforge-db-'));
    dirs.push(dir);
    const first = await openDbForEnv({ ADFORGE_ENV: 'dev', ADFORGE_DATA_DIR: dir });
    await expect(openDbForEnv({ ADFORGE_ENV: 'dev', ADFORGE_DATA_DIR: dir })).rejects.toThrow(/already open by pid/);
    await first.close();
  });

  it('Db accepts the result of both openers (type-level)', () => {
    const f = (d: Db) => d.select().from(schema.jobs);
    expect(typeof f).toBe('function');
    const g = async () => f((await openDb()).db);
    const h = async () => f((await openDbForEnv({ ADFORGE_ENV: 'dev', ADFORGE_DATA_DIR: 'x' })).db);
    expect([g, h]).toHaveLength(2);
  });
});
