/**
 * Unit tests for the retention CLI (`@/cli/oauth-states-cleanup`) — state design
 * §6. The argument parser and the batch/drain loop are pure and tested here; the
 * process wiring (env, DB, exit) is import-guarded so vitest touches neither. The
 * store's dead-row-only predicate is proven separately against real Postgres.
 */

import { describe, expect, it, vi } from 'vitest';

import { CliArgumentError, MAX_CLEANUP_BATCH, parseArgs, parseBatchSize, runCleanup } from '@/cli/oauth-states-cleanup.js';
import type { DrizzleOAuthStateStore } from '@/repositories/oauth-state-repository.js';

const makeStore = () => {
  const deleteExpiredAndConsumed = vi.fn();
  const store = { deleteExpiredAndConsumed } as unknown as Pick<DrizzleOAuthStateStore, 'deleteExpiredAndConsumed'>;
  return { store, deleteExpiredAndConsumed };
};

describe('parseBatchSize', () => {
  it('accepts undefined (unset) and integers within [1, MAX]', () => {
    expect(parseBatchSize(undefined)).toBeUndefined();
    expect(parseBatchSize('1')).toBe(1);
    expect(parseBatchSize('100')).toBe(100);
    expect(parseBatchSize(String(MAX_CLEANUP_BATCH))).toBe(MAX_CLEANUP_BATCH);
  });

  it('rejects zero, over-max, negative, non-numeric, fractional, and empty values', () => {
    for (const raw of ['0', String(MAX_CLEANUP_BATCH + 1), '-5', 'abc', '1.5', '']) {
      expect(() => parseBatchSize(raw)).toThrow(CliArgumentError);
    }
  });
});

describe('parseArgs', () => {
  it('defaults to no batch size and no drain', () => {
    expect(parseArgs([])).toEqual({ batchSize: undefined, drain: false });
  });

  it('reads --batch-size in both spaced and = forms, and --drain', () => {
    expect(parseArgs(['--batch-size', '100'])).toEqual({ batchSize: 100, drain: false });
    expect(parseArgs(['--batch-size=100'])).toEqual({ batchSize: 100, drain: false });
    expect(parseArgs(['--drain'])).toEqual({ batchSize: undefined, drain: true });
    expect(parseArgs(['--batch-size', '100', '--drain'])).toEqual({ batchSize: 100, drain: true });
  });

  it('treats a valueless --batch-size (bare, or followed by a flag) as unset', () => {
    expect(parseArgs(['--batch-size'])).toEqual({ batchSize: undefined, drain: false });
    expect(parseArgs(['--batch-size', '--drain'])).toEqual({ batchSize: undefined, drain: true });
  });

  it('propagates a bad --batch-size value and rejects positional arguments', () => {
    expect(() => parseArgs(['--batch-size=bad'])).toThrow(CliArgumentError);
    expect(() => parseArgs(['positional'])).toThrow('unexpected argument "positional"');
  });
});

describe('runCleanup', () => {
  it('single-batch mode issues exactly one bounded delete and returns its count', async () => {
    const { store, deleteExpiredAndConsumed } = makeStore();
    deleteExpiredAndConsumed.mockResolvedValue(7);
    expect(await runCleanup({ store, batchSize: 100, drain: false })).toBe(7);
    expect(deleteExpiredAndConsumed).toHaveBeenCalledTimes(1);
    expect(deleteExpiredAndConsumed).toHaveBeenCalledWith({ limit: 100 });
  });

  it('single-batch mode with no batch size passes an empty options object (store default applies)', async () => {
    const { store, deleteExpiredAndConsumed } = makeStore();
    deleteExpiredAndConsumed.mockResolvedValue(0);
    expect(await runCleanup({ store, batchSize: undefined, drain: false })).toBe(0);
    expect(deleteExpiredAndConsumed).toHaveBeenCalledWith({});
  });

  it('drain mode sums batches and stops at the first empty one', async () => {
    const { store, deleteExpiredAndConsumed } = makeStore();
    deleteExpiredAndConsumed.mockResolvedValueOnce(5).mockResolvedValueOnce(3).mockResolvedValueOnce(0);
    expect(await runCleanup({ store, batchSize: 50, drain: true })).toBe(8);
    expect(deleteExpiredAndConsumed).toHaveBeenCalledTimes(3);
  });

  it('drain mode stops after a single empty batch', async () => {
    const { store, deleteExpiredAndConsumed } = makeStore();
    deleteExpiredAndConsumed.mockResolvedValue(0);
    expect(await runCleanup({ store, batchSize: undefined, drain: true })).toBe(0);
    expect(deleteExpiredAndConsumed).toHaveBeenCalledTimes(1);
  });
});
