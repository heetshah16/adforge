import { fileURLToPath } from 'node:url';
import { dataDirWarnings, parseEnv } from '@adforge/core/config/env';
import { openDbForEnv } from '../client';
import { readBrandFixture, seedKrishna } from './brand-krishna';

try {
  process.loadEnvFile(new URL('../../../../.env', import.meta.url));
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
}

const brand = process.argv.slice(2).filter((a) => a !== '--').at(-1) ?? 'krishna';
if (brand !== 'krishna') throw new Error(`unknown brand "${brand}" (only "krishna" is seeded)`);

const env = parseEnv(process.env);
for (const w of dataDirWarnings(env.ADFORGE_DATA_DIR)) console.warn(`WARN ${w}`);
const { db, close } = await openDbForEnv(env);
try {
  const created = await seedKrishna(db, readBrandFixture(fileURLToPath(new URL('../../../../fixtures/eval-products', import.meta.url))));
  console.log(created.length ? `seeded ${created.join(', ')}` : 'nothing to seed (already present)');
} finally {
  await close();
}
