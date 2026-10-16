import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { MediaRef, PutOptions, StorageProvider } from '@adforge/core/providers/types';

const EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'audio/wav': 'wav',
  'application/json': 'json',
};
const KEY = /^[0-9a-f]{2}\/[0-9a-f]{64}\.[a-z0-9]+$/;

/** POC stand-in for R2. Content-addressed: same bytes → same key → one file. */
export class LocalDiskStorage implements StorageProvider {
  readonly id = 'local';

  constructor(
    private readonly root: string,
    private readonly publicBaseUrl: string,
  ) {}

  pathFor(key: string): string {
    if (!KEY.test(key)) throw new Error(`Invalid storage key: ${key}`);
    return join(this.root, key);
  }

  urlFor(key: string): string {
    return `${this.publicBaseUrl}/media/${key}`;
  }

  async put(bytes: Uint8Array, opts: PutOptions): Promise<MediaRef> {
    const ext = EXT[opts.mime];
    if (!ext) throw new Error(`Unsupported mime type: ${opts.mime}`);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const key = `${sha256.slice(0, 2)}/${sha256}.${ext}`;
    const path = this.pathFor(key);

    const exists = await access(path).then(() => true, () => false);
    if (!exists) {
      await mkdir(dirname(path), { recursive: true });
      // Write-then-rename so a crash never leaves a truncated file under a valid key.
      const tmp = `${path}.${randomUUID()}.tmp`;
      await writeFile(tmp, bytes);
      await rename(tmp, path);
    }

    return {
      id: key,
      url: this.urlFor(key),
      mime: opts.mime,
      sha256,
      bytes: bytes.byteLength,
      width: opts.width,
      height: opts.height,
      durationSec: opts.durationSec,
    };
  }

  async read(key: string): Promise<Uint8Array> {
    return readFile(this.pathFor(key));
  }
}
