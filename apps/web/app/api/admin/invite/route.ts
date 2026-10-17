import { inviteHandler } from '../../../../lib/server/admin-api';
import { adminGetWaitlistEntry, adminMarkInvited, inviteByEmail } from '../../../../lib/server/admin-owner';
import { serverEnv } from '../../../../lib/server/env';
import { requireApiUser } from '../../../../lib/server/session';

export const POST = (req: Request) =>
  inviteHandler(
    { requireUser: requireApiUser, siteUrl: serverEnv().ADFORGE_SITE_URL, get: adminGetWaitlistEntry, markInvited: adminMarkInvited, invite: inviteByEmail },
    req,
  );
