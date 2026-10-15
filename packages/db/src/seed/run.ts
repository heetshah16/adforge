import { dataDirWarnings, parseEnv } from '@adforge/core/config/env';
import { openDb } from '../client';
import { seedLocalUser, seedVocabulary } from './seed';

try {
  process.loadEnvFile(new URL('../../../../.env', import.meta.url));
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
}

const env = parseEnv(process.env);
for (const w of dataDirWarnings(env.ADFORGE_DATA_DIR)) console.warn(`WARN ${w}`);

const { db, close } = await openDb(env.ADFORGE_DATA_DIR);
try {
  await seedVocabulary(db);
  const ids = await seedLocalUser(db);
  console.log('seeded', ids);
} finally {
  await close();
}
