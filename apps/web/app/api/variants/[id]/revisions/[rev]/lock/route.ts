import { lockRevisionHandler, unlockRevisionHandler } from '../../../../../../../lib/server/revisions-api';
import { revisionsCtx } from '../../../../../../../lib/server/jobs-ctx';

type P = { params: Promise<{ id: string; rev: string }> };
export const POST = async (req: Request, { params }: P) => { const { id, rev } = await params; return lockRevisionHandler(revisionsCtx(), req, id, rev); };
export const DELETE = async (req: Request) => unlockRevisionHandler(revisionsCtx(), req);
