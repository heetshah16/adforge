import { mintUploadHandler } from '../../../lib/server/uploads-api';
import { uploadsCtx } from '../../../lib/server/jobs-ctx';

export const POST = (req: Request) => mintUploadHandler(uploadsCtx(), req);
