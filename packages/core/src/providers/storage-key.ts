/** Pure key helpers (no Node builtins): safe for any bundle, unlike the AsyncLocalStorage scope in storage-scope.ts. */

/** Dev keys are `<2-hex>/<sha256>.<ext>`; prod keys carry their tenant: `org/<orgId>/<2-hex>/<sha256>.<ext>` (lowercase uuid). */
export const STORAGE_KEY_RE = /^(?:org\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/)?[0-9a-f]{2}\/[0-9a-f]{64}\.[a-z0-9]+$/;
/** An org id as it appears in a key: a lowercase uuid. */
export const ORG_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The media types storage accepts, and the extension each is keyed under. */
export const MIME_EXT: Readonly<Record<string, string>> = Object.freeze({
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'audio/wav': 'wav',
  'application/json': 'json',
});

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

/** Splits a storage key into its org (null for a dev key), sha256 and extension; null when it is not a storage key. */
export function parseKey(key: string): { org: string | null; sha: string; ext: string } | null {
  if (!STORAGE_KEY_RE.test(key)) return null;
  const m = /^(?:org\/([^/]+)\/)?[0-9a-f]{2}\/([0-9a-f]{64})\.([a-z0-9]+)$/.exec(key)!;
  return { org: m[1] ?? null, sha: m[2]!, ext: m[3]! };
}
