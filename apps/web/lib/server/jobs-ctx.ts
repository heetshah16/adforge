import { serverEnv } from './env';
import { sendJobRequested } from './events';
import type { JobsCtx } from './jobs-api';
import { failJobOwner, withCurrentUser } from './jobs-owner';
import { requireApiUser } from './session';
import { mediaStore } from './storage';

export const jobsCtx = (): JobsCtx => ({ auth: requireApiUser, run: withCurrentUser, siteUrl: serverEnv().ADFORGE_SITE_URL, storage: mediaStore(), send: sendJobRequested, fail: failJobOwner });
