const windows = new Map<string, { count: number; resetAt: number }>();
const PRUNE_AT = 10_000;

/** Test hook: how many keys are currently tracked. */
export const trackedKeyCount = () => windows.size;

/**
 * Fixed window, in memory. Expired windows are swept once the map reaches PRUNE_AT keys.
 * ponytail: per-process; if every key is still active the sweep frees nothing and runs on each new key. B5 swaps in a shared store (Postgres or Redis).
 */
export async function rateLimit(key: string, limit: number, windowSec: number): Promise<boolean> {
  const now = Date.now();
  if (windows.size >= PRUNE_AT) for (const [k, v] of windows) if (v.resetAt <= now) windows.delete(k);
  const w = windows.get(key);
  if (!w || w.resetAt <= now) {
    windows.set(key, { count: 1, resetAt: now + windowSec * 1000 });
    return true;
  }
  if (w.count >= limit) return false;
  w.count++;
  return true;
}
