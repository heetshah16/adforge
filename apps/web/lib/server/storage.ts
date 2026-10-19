import { join } from 'node:path';
import { LocalDiskStorage } from '@adforge/provider-local-storage';
import { R2Storage } from '@adforge/provider-r2';
import { serverEnv } from './env';

/**
 * Media store for the web app: local disk in dev, R2 in prod. No cache: the web runs on Vercel,
 * which has no disk to keep one on. parseServerEnv guarantees the R2 vars when the provider is r2.
 */
export function mediaStore(): LocalDiskStorage | R2Storage {
  const env = serverEnv();
  if (env.ADFORGE_PROVIDER_STORAGE === 'r2') {
    return new R2Storage({
      accountId: env.R2_ACCOUNT_ID!,
      accessKeyId: env.R2_ACCESS_KEY_ID!,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY!,
      bucket: env.R2_BUCKET!,
      publicUrl: env.ADFORGE_PUBLIC_URL,
      timeoutMs: env.R2_TIMEOUT_MS,
    });
  }
  return new LocalDiskStorage(join(env.ADFORGE_DATA_DIR, 'media'), env.ADFORGE_PUBLIC_URL);
}
