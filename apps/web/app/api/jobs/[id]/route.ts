import { getJobHandler } from '../../../../lib/server/jobs-api';
import { jobsCtx } from '../../../../lib/server/jobs-ctx';

export const GET = async (_req: Request, { params }: { params: Promise<{ id: string }> }) => getJobHandler(jobsCtx(), (await params).id);
