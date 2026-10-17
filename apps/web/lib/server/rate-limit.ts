const windows = new Map<string, { count: number; resetAt: number }>();

/** Fixed window, in memory. ponytail: per-process and unbounded key set; B5 swaps in a shared store (Postgres or Redis) with pruning. */
export async function rateLimit(key: string, limit: number, windowSec: number): Promise<boolean> {
  const now = Date.now();
  const w = windows.get(key);
  if (!w || w.resetAt <= now) {
    windows.set(key, { count: 1, resetAt: now + windowSec * 1000 });
    return true;
  }
  if (w.count >= limit) return false;
  w.count++;
  return true;
}
