import type { NextRequest } from 'next/server';
import { inngestHandler } from '../../../lib/server/inngest-owner';

// Called by Inngest, never by a browser: no session. The proxy lets /api/* through unredirected, and in cloud mode serve()
// rejects any request not signed with INNGEST_SIGNING_KEY (inngest-owner.ts). Only this one route exists under /api/inngest.
export const GET = (req: NextRequest) => inngestHandler().GET(req, undefined);
export const POST = (req: NextRequest) => inngestHandler().POST(req, undefined);
export const PUT = (req: NextRequest) => inngestHandler().PUT(req, undefined);
