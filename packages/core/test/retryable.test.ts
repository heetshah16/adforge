import { describe, expect, it } from 'vitest';
import { isRetryable } from '../src/providers/types';

describe('isRetryable', () => {
  it('retries transient failures only', () => {
    expect(isRetryable('UPSTREAM')).toBe(true);
    expect(isRetryable('TIMEOUT')).toBe(true);
    expect(isRetryable('RATE_LIMIT')).toBe(true);
    expect(isRetryable('INVALID_INPUT')).toBe(false);
    expect(isRetryable('AUTH')).toBe(false);
    expect(isRetryable('CONTENT_POLICY')).toBe(false);
    expect(isRetryable('UNKNOWN')).toBe(false);
  });
});
