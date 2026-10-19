import { localPutHandler } from '../../../../../lib/server/uploads-api';
import { uploadsCtx } from '../../../../../lib/server/jobs-ctx';

export const PUT = async (req: Request, { params }: { params: Promise<{ key: string[] }> }) => localPutHandler(uploadsCtx(), req, (await params).key);
