import { createRevisionHandler, listRevisionsHandler } from '../../../../../lib/server/revisions-api';
import { revisionsCtx } from '../../../../../lib/server/jobs-ctx';

type P = { params: Promise<{ id: string }> };
export const GET = async (_req: Request, { params }: P) => listRevisionsHandler(revisionsCtx(), (await params).id);
export const POST = async (req: Request, { params }: P) => createRevisionHandler(revisionsCtx(), req, (await params).id);
