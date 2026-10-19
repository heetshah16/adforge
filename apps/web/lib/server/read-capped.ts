/** Reads at most `max` bytes of the body whether or not Content-Length was declared. Null = too large. */
export async function readBytesCapped(req: Request, max: number): Promise<Uint8Array | null> {
  if (Number(req.headers.get('content-length') ?? 0) > max) return null;
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out;
}

export async function readTextCapped(req: Request, max: number): Promise<string | null> {
  const b = await readBytesCapped(req, max);
  return b === null ? null : new TextDecoder().decode(b);
}
