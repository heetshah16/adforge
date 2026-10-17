import { createJobHandler } from '../../../lib/server/jobs-api';
import { jobsCtx } from '../../../lib/server/jobs-ctx';

export const POST = (req: Request) => createJobHandler(jobsCtx(), req);
