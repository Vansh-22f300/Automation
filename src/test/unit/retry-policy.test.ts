/**
 * Unit tests for the business retry policy — pure, no database, no queue.
 *
 * These pin the two properties the rest of the system relies on: the un-jittered
 * ceiling grows exponentially and then flattens at `maxDelayMs`, and the jittered
 * delay always lands in `[raw/2, raw)` for a `random` in `[0, 1)`. Because
 * `random` is injectable, every assertion here is deterministic.
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_RETRY_POLICY, createRetryPolicy } from '@/domain/retry-policy.js';

describe('createRetryPolicy', () => {
  it('exposes its config', () => {
    const policy = createRetryPolicy();
    expect(policy.config).toEqual(DEFAULT_RETRY_POLICY);
  });

  it('is equal-jitter: half fixed, half scaled by random', () => {
    // random = 0 → the floor (raw/2); random → 1 → just under raw.
    const floor = createRetryPolicy(DEFAULT_RETRY_POLICY, () => 0);
    const ceil = createRetryPolicy(DEFAULT_RETRY_POLICY, () => 0.999999);

    // retryCount 0 → raw = base = 1000 → floor 500, ceil ~1000.
    expect(floor.backoffMs(0)).toBe(500);
    expect(ceil.backoffMs(0)).toBeGreaterThan(999);
    expect(ceil.backoffMs(0)).toBeLessThan(1000);
  });

  it('grows exponentially with retry_count until it hits the cap', () => {
    const policy = createRetryPolicy(DEFAULT_RETRY_POLICY, () => 0); // floor = raw/2
    // raw = min(1000 * 2^n, 300000); floor = raw/2.
    expect(policy.backoffMs(0)).toBe(500); // raw 1000
    expect(policy.backoffMs(1)).toBe(1_000); // raw 2000
    expect(policy.backoffMs(2)).toBe(2_000); // raw 4000
    expect(policy.backoffMs(3)).toBe(4_000); // raw 8000
    // 1000 * 2^9 = 512000 > 300000 → capped at 300000, floor 150000.
    expect(policy.backoffMs(9)).toBe(150_000);
    expect(policy.backoffMs(50)).toBe(150_000); // stays capped
  });

  it('keeps the jittered delay within [raw/2, raw)', () => {
    const random = () => 0.5;
    const policy = createRetryPolicy(DEFAULT_RETRY_POLICY, random);
    // raw = 2000 at retryCount 1 → 1000 + 0.5*1000 = 1500.
    expect(policy.backoffMs(1)).toBe(1_500);
  });

  it('treats a negative retry_count as zero (defensive)', () => {
    const policy = createRetryPolicy(DEFAULT_RETRY_POLICY, () => 0);
    expect(policy.backoffMs(-3)).toBe(500);
  });
});
