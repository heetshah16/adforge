import { AsyncLocalStorage } from 'node:async_hooks';
import { ORG_ID_RE } from './storage-key';

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
