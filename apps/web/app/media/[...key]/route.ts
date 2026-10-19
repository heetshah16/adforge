import { mediaHandler } from '../../../lib/server/media-api';
import { mediaCtx } from '../../../lib/server/jobs-ctx';

export const GET = async (_req: Request, { params }: { params: Promise<{ key: string[] }> }) => mediaHandler(mediaCtx(), (await params).key);
