import { describe, expect, it } from 'vitest';
import { rateLimit, trackedKeyCount } from '../lib/server/rate-limit';

describe('rateLimit pruning', () => {
  it('sweeps expired windows once the map reaches 10,000 keys, and keeps live ones', async () => {
    expect(await rateLimit('live', 5, 600)).toBe(true);
    for (let i = 0; i < 9_999; i++) await rateLimit(`expired-${i}`, 5, 0); // windowSec 0: expired on arrival
    expect(trackedKeyCount()).toBe(10_000);
    expect(await rateLimit('new', 5, 600)).toBe(true); // triggers the sweep
    expect(trackedKeyCount()).toBe(2); // 'live' and 'new' survive; the 9,999 expired keys are gone
  });
});
