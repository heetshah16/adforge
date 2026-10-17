import { waitlistHandler } from '../../../lib/server/waitlist-api';
import { addToWaitlist } from '../../../lib/server/waitlist-owner';
import { rateLimit } from '../../../lib/server/rate-limit';

export const POST = (req: Request) => waitlistHandler({ insert: addToWaitlist, rateLimit }, req);
