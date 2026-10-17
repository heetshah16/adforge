import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

/** node:http → Web Request (so every route is a plain (Request) => Response function). */
export function toRequest(req: IncomingMessage, base: string): Request {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) for (const x of v) headers.append(k, x);
    else if (v !== undefined) headers.set(k, v);
  }
  const method = req.method ?? 'GET';
  const body = method === 'GET' || method === 'HEAD' ? undefined : (Readable.toWeb(req) as ReadableStream<Uint8Array>);
  return new Request(new URL(req.url ?? '/', base), { method, headers, body, duplex: 'half' } as RequestInit);
}

export async function send(res: ServerResponse, r: Response): Promise<void> {
  res.writeHead(r.status, Object.fromEntries(r.headers));
  if (r.body) for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) res.write(chunk);
  res.end();
}
