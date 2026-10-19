import { AsyncLocalStorage } from 'node:async_hooks';

/** Dev keys are `<2-hex>/<sha256>.<ext>`; prod keys carry their tenant: `org/<orgId>/<2-hex>/<sha256>.<ext>` (lowercase uuid). */
export const STORAGE_KEY_RE = /^(?:org\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/)?[0-9a-f]{2}\/[0-9a-f]{64}\.[a-z0-9]+$/;
const ORG_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The media types storage accepts, and the extension each is keyed under. */
export const MIME_EXT: Readonly<Record<string, string>> = Object.freeze({
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'audio/wav': 'wav',
  'application/json': 'json',
});

const scope = new AsyncLocalStorage<string>();

/**
 * Runs `fn` with `orgId` as the storage tenant, so a put can prefix its key without any request type carrying the org.
 * Re-entering the same org is a no-op; a different org throws (one run never writes for two tenants).
 */
export async function withStorageOrg<T>(orgId: string, fn: () => Promise<T>): Promise<T> {
  if (!ORG_ID_RE.test(orgId)) throw new Error(`invalid storage org scope: ${JSON.stringify(orgId)} is not a lowercase uuid`);
  const current = scope.getStore();
  if (current === orgId) return fn();
  if (current) throw new Error(`storage org scope is already ${current}; refusing to enter ${orgId}`);
  return scope.run(orgId, fn);
}

/** The storage tenant of the running code, or undefined outside any scope. */
export const storageOrg = (): string | undefined => scope.getStore();

export function orgKey(orgId: string, sha256: string, ext: string): string {
  const key = `org/${orgId}/${sha256.slice(0, 2)}/${sha256}.${ext}`;
  if (!STORAGE_KEY_RE.test(key)) throw new Error(`not a storage key: ${key}`);
  return key;
}

/** The org a key belongs to; null for a dev (unprefixed) key. Throws on anything that is not a storage key. */
export function orgOfKey(key: string): string | null {
  if (!STORAGE_KEY_RE.test(key)) throw new Error(`not a storage key: ${key}`);
  return key.startsWith('org/') ? key.slice(4, 40) : null;
}
