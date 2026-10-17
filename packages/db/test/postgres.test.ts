import { describe, expect, it } from 'vitest';
import { openPostgres } from '../src/client';
import { loadRegistry } from '../src/registry';
import { seedVocabulary } from '../src/seed/seed';

const url = process.env.ADFORGE_TEST_DATABASE_URL;

describe.skipIf(!url)('openPostgres', () => {
  it('migrates, seeds, and loads the registry; reopening re-migrates cleanly', async () => {
    const a = await openPostgres(url!);
    await seedVocabulary(a.db);
    const reg = await loadRegistry(a.db);
    expect(reg.archetypes).toHaveLength(7);
    expect(reg.formats).toHaveLength(8);
    expect(reg.hooks).toHaveLength(7);
    await a.close();
    const b = await openPostgres(url!); // migrate twice
    await b.close();
  });

  it('rejects an unreachable host within the connect timeout', async () => {
    const t = Date.now();
    await expect(openPostgres('postgresql://u:p@10.255.255.1:5432/x', { connectTimeoutSec: 2 })).rejects.toThrow();
    expect(Date.now() - t).toBeLessThan(5000);
  }, 10_000);
});
