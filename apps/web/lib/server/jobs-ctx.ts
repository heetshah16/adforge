import { serverEnv } from './env';
import { sendJobRequested } from './events';
import type { JobsCtx } from './jobs-api';
import { failJobOwner, withCurrentUser } from './jobs-owner';
import { requireApiUser } from './session';
import { mediaStore } from './storage';
import type { MediaCtx } from './media-api';
import type { UploadsCtx } from './uploads-api';

const r2 = () => serverEnv().ADFORGE_PROVIDER_STORAGE === 'r2';

export const jobsCtx = (): JobsCtx => ({ auth: requireApiUser, run: withCurrentUser, siteUrl: serverEnv().ADFORGE_SITE_URL, r2: r2(), storage: mediaStore(), send: sendJobRequested, fail: failJobOwner });
export const uploadsCtx = (): UploadsCtx => ({ auth: requireApiUser, siteUrl: serverEnv().ADFORGE_SITE_URL, r2: r2(), store: mediaStore() });
export const mediaCtx = (): MediaCtx => {
  const store = mediaStore();
  return {
    auth: requireApiUser,
    run: withCurrentUser,
    r2: r2(),
    ttlSec: serverEnv().ADFORGE_MEDIA_TTL_SEC,
    presignGet: (key, ttl) => {
      if (!('presignGet' in store)) throw new Error('local store cannot presign');
      return store.presignGet(key, ttl);
    },
  };
};
