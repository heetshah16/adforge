import { approveHandler } from '../../../../../../../lib/server/jobs-api';
import { jobsCtx } from '../../../../../../../lib/server/jobs-ctx';

export const POST = async (_req: Request, { params }: { params: Promise<{ id: string; n: string }> }) => {
  const { id, n } = await params;
  return approveHandler(jobsCtx(), id, n);
};
