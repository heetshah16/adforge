import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { STORAGE_KEY_RE } from '@adforge/core/providers/storage-key';
import type { MediaRef, PutOptions, StorageProvider } from '@adforge/core/providers/types';

/**
 * Read-through disk cache over a remote store (the GPU worker's copy of R2 media).
 * Keys mirror the inner store's keys under `dir`.
 */
// ponytail: no eviction; the cache grows with media until the worker disk fills. Add LRU by mtime if it does.
export class CachedStorage implements StorageProvider {
  readonly id: string;

  constructor(
    private readonly inner: StorageProvider,
    private readonly dir: string,
  ) {
    this.id = `cached:${inner.id}`;
  }

  private pathFor(key: string): string {
    if (!STORAGE_KEY_RE.test(key)) throw new Error(`Invalid storage key: ${key}`);
    return join(this.dir, ...key.split('/'));
  }

  urlFor(key: string): string {
    return this.inner.urlFor(key);
  }

  async put(bytes: Uint8Array, opts: PutOptions): Promise<MediaRef> {
    const ref = await this.inner.put(bytes, opts);
    await this.fill(ref.id, bytes);
    return ref;
  }

  async read(key: string): Promise<Uint8Array> {
    const path = this.pathFor(key);
    try {
      return await readFile(path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    const bytes = await this.inner.read(key); // its errors propagate unchanged
    await this.fill(key, bytes);
    return bytes;
  }

  /** Write-then-rename so a crash never leaves a truncated file under a valid key. */
  private async fill(key: string, bytes: Uint8Array): Promise<void> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${randomUUID()}.tmp`;
    await writeFile(tmp, bytes);
    await rename(tmp, path);
  }
}
