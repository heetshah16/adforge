import { dataDirWarnings, parseEnv } from './env';

const envFile = new URL('../../../../.env', import.meta.url);
try {
  process.loadEnvFile(envFile);
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
}

try {
  const env = parseEnv(process.env);
  for (const w of dataDirWarnings(env.ADFORGE_DATA_DIR)) console.warn(`WARN ${w}`);
  console.log('env ok');
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
