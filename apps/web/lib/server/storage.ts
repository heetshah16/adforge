import { join } from 'node:path';
import { LocalDiskStorage } from '@adforge/provider-local-storage';
import { serverEnv } from './env';

/** Dev media on local disk (served by the worker at ADFORGE_PUBLIC_URL) until R2 lands in B3. */
export function devStorage(): LocalDiskStorage {
  const env = serverEnv();
  return new LocalDiskStorage(join(env.ADFORGE_DATA_DIR, 'media'), env.ADFORGE_PUBLIC_URL);
}
