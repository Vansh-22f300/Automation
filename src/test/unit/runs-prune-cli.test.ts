/**
 * Unit tests for `pnpm runs:prune` CLI logic.
 *
 * The CLI dispatcher in `src/cli/runs-prune.ts` is split into a pure
 * argument-parsing surface, a pure orchestration surface (`runPrune`), and an
 * entry-point shell that wires the database. These tests exercise the two
 * pure surfaces against a hand-rolled fake `RunPruneRepository`.
 *
 * Coverage:
 *   - `parseOlderThan` accepts Nd and Nh; rejects 0, negatives, malformed
 *     strings, and durations > 5 years.
 *   - `parseBatchSize` honours the default; rejects 0, negatives, non-integers,
 *     and values outside [1, 1000].
 *   - `parseArgs` requires tenantId and --older-than; honours --dry-run and
 *     --batch-size.
 *   - `exitCodeFor` matches the documented matrix (real: 0 / 1 / 2; dry-run:
 *     0; boot-misconfig is 2 from the entry point).
 *   - `reasonForPruneFailure` is a stable mapping.
 *   - `runPrune` in dry-run mode enumerates via the fake repository and never
 *     invokes `pruneRun`; in real-run mode calls `pruneRun` per row and
 *     classifies outcomes; partial-failure exits 1, total-failure exits 2.
 *   - `runPrune` paginates with the keyset cursor: each call sees the previous
 *     page's nextCursor.
 *   - `runPrune` per-row errors are logged + counted as `failed` and the loop
 *     continues.
 *
 * The cryptographic and DB-side guarantees are exercised by the integration
 * suite in `src/test/integration/runs-prune.test.ts`. This file stays
 * database-free.
 */

import { Writable } from 'node:stream';

import { beforeEach, describe, expect, it } from 'vitest';

import {
  type CliArgumentError,
  DEFAULT_BATCH_SIZE,
  MAX_BATCH_SIZE,
  exitCodeFor,
  parseArgs,
  parseBatchSize,
  parseOlderThan,
  reasonForPruneFailure,
  runPrune,
} from '@/cli/runs-prune.js';
import type { RunPruneSummary } from '@/cli/runs-prune.js';
import type {
  ListPrunableOptions,
  PrunableListPage,
  PrunableRun,
  PruneRunOutcome,
  RunPruneRepository,
} from '@/repositories/run-prune-repository.js';

const TENANT = 'tenant-1';

function makeRow(id: string, status: 'succeeded' | 'failed' | 'cancelled', finishedAt: Date): PrunableRun {
  return { id, status, finishedAt };
}

class FakeRunPruneRepository {
  readonly listCalls: Array<{ cutoff: Date; opts: ListPrunableOptions }> = [];
  readonly pruneCalls: Array<{ id: string; cutoff: Date }> = [];
  /** Pages returned to listPrunable in order. */
  pages: PrunableListPage[] = [{ items: [], nextCursor: null }];
  /** Per-id outcome for pruneRun; `undefined` => default 'pruned'. */
  pruneOutcomes: Map<string, PruneRunOutcome> = new Map();
  /** When set, pruneRun throws the named error for that id. */
  pruneThrows: Map<string, Error> = new Map();
  /** Default pruneRun outcome. */
  defaultPruneOutcome: 'pruned' | 'not-found' = 'pruned';

  async listPrunable(cutoff: Date, opts: ListPrunableOptions = {}): Promise<PrunableListPage> {
    this.listCalls.push({ cutoff, opts });
    const idx = Math.min(this.listCalls.length - 1, this.pages.length - 1);
    return this.pages[idx] ?? { items: [], nextCursor: null };
  }

  async pruneRun(id: string, cutoff: Date): Promise<PruneRunOutcome> {
    this.pruneCalls.push({ id, cutoff });
    const err = this.pruneThrows.get(id);
    if (err !== undefined) throw err;
    const configured = this.pruneOutcomes.get(id);
    if (configured !== undefined) return configured;
    if (this.defaultPruneOutcome === 'not-found') {
      return { outcome: 'not-found', id, status: null, finishedAt: null };
    }
    return { outcome: 'pruned', id, status: 'succeeded', finishedAt: new Date() };
  }
}

function makeSummaryBuffer(): { stream: Writable; text: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString('utf8'));
      cb();
    },
  });
  return { stream, text: () => chunks.join('') };
}

function captureLogger(): { logger: { info: (p: unknown, m: string) => void; error: (p: unknown, m: string) => void; warn: (p: unknown, m: string) => void; debug: (p: unknown, m: string) => void; fatal: (p: unknown, m: string) => void }; events: Array<{ level: string; payload: Record<string, unknown>; msg: string }> } {
  const events: Array<{ level: string; payload: Record<string, unknown>; msg: string }> = [];
  const capture = (level: string) => (payload: unknown, msg: string) => {
    events.push({ level, payload: (payload ?? {}) as Record<string, unknown>, msg });
  };
  return {
    logger: {
      info: capture('info'),
      error: capture('error'),
      warn: capture('warn'),
      debug: capture('debug'),
      fatal: capture('fatal'),
    },
    events,
  };
}

describe('parseOlderThan', () => {
  it('accepts Nd syntax', () => {
    const parsed = parseOlderThan('90d');
    expect(parsed.display).toBe('90d');
    expect(parsed.milliseconds).toBe(90 * 24 * 60 * 60 * 1000);
  });

  it('accepts Nh syntax', () => {
    const parsed = parseOlderThan('24h');
    expect(parsed.display).toBe('24h');
    expect(parsed.milliseconds).toBe(24 * 60 * 60 * 1000);
  });

  it('rejects 0d', () => {
    expect(() => parseOlderThan('0d')).toThrow();
  });

  it('rejects 0h', () => {
    expect(() => parseOlderThan('0h')).toThrow();
  });

  it('rejects negative durations (non-numeric prefix)', () => {
    expect(() => parseOlderThan('-5d')).toThrow();
  });

  it('rejects malformed strings', () => {
    expect(() => parseOlderThan('forever')).toThrow();
    expect(() => parseOlderThan('90')).toThrow();
    expect(() => parseOlderThan('90days')).toThrow();
    expect(() => parseOlderThan('d90')).toThrow();
    expect(() => parseOlderThan('90m')).toThrow();
    expect(() => parseOlderThan('')).toThrow();
  });

  it('rejects durations greater than 5 years', () => {
    expect(() => parseOlderThan('1827d')).toThrow(); // > 5y
    expect(() => parseOlderThan('50000h')).toThrow();
  });

  it('accepts exactly the 5-year boundary or close below', () => {
    expect(() => parseOlderThan('1825d')).not.toThrow();
  });
});

describe('parseBatchSize', () => {
  it('returns the default when undefined', () => {
    expect(parseBatchSize(undefined)).toBe(DEFAULT_BATCH_SIZE);
    expect(DEFAULT_BATCH_SIZE).toBe(100);
  });

  it('accepts values in [1, 1000]', () => {
    expect(parseBatchSize('1')).toBe(1);
    expect(parseBatchSize('500')).toBe(500);
    expect(parseBatchSize(String(MAX_BATCH_SIZE))).toBe(MAX_BATCH_SIZE);
  });

  it('rejects 0', () => {
    expect(() => parseBatchSize('0')).toThrow();
  });

  it('rejects negative values', () => {
    expect(() => parseBatchSize('-1')).toThrow();
  });

  it('rejects non-integers', () => {
    expect(() => parseBatchSize('1.5')).toThrow();
  });

  it('rejects values > 1000', () => {
    expect(() => parseBatchSize('1001')).toThrow();
    expect(() => parseBatchSize('5000')).toThrow();
  });
});

describe('parseArgs', () => {
  it('requires the tenant id', () => {
    expect(() => parseArgs(['--older-than', '90d'])).toThrow(/tenantId/);
    expect(() => parseArgs([])).toThrow();
  });

  it('requires --older-than', () => {
    let caught: unknown;
    try {
      parseArgs([TENANT]);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect((caught as Error).message).toContain('--older-than is required');
  });

  it('parses the minimal real-run invocation', () => {
    const parsed = parseArgs([TENANT, '--older-than', '90d']);
    expect(parsed.tenantId).toBe(TENANT);
    expect(parsed.olderThan.display).toBe('90d');
    expect(parsed.dryRun).toBe(false);
    expect(parsed.batchSize).toBe(DEFAULT_BATCH_SIZE);
  });

  it('parses --dry-run and --batch-size together', () => {
    const parsed = parseArgs([TENANT, '--older-than', '24h', '--dry-run', '--batch-size', '50']);
    expect(parsed.tenantId).toBe(TENANT);
    expect(parsed.olderThan.display).toBe('24h');
    expect(parsed.dryRun).toBe(true);
    expect(parsed.batchSize).toBe(50);
  });

  it('accepts --key=value syntax', () => {
    const parsed = parseArgs([TENANT, '--older-than=90d', '--batch-size=25']);
    expect(parsed.olderThan.display).toBe('90d');
    expect(parsed.batchSize).toBe(25);
  });

  it('propagates parseOlderThan rejections', () => {
    expect(() => parseArgs([TENANT, '--older-than', '0d'])).toThrow(/positive integer/);
    expect(() => parseArgs([TENANT, '--older-than', 'forever'])).toThrow(/days.*hours/);
  });

  it('propagates parseBatchSize rejections', () => {
    expect(() => parseArgs([TENANT, '--older-than', '90d', '--batch-size', '0'])).toThrow();
    expect(() => parseArgs([TENANT, '--older-than', '90d', '--batch-size', '5000'])).toThrow();
  });

  it('CliArgumentError carries a stable code', () => {
    let caught: unknown;
    try {
      parseArgs([TENANT]);
    } catch (e) {
      caught = e;
    }
    expect((caught as { code?: string }).code).toBe('cli_argument_invalid');
  });
});

describe('exitCodeFor', () => {
  function mk(s: Partial<RunPruneSummary>): RunPruneSummary {
    return {
      pruned: 0,
      skipped: 0,
      failed: 0,
      wouldPrune: 0,
      wouldFail: 0,
      dryRun: false,
      ...s,
    };
  }

  it('real: nothing to do → 0', () => {
    expect(exitCodeFor(mk({}))).toBe(0);
  });

  it('real: all pruned → 0', () => {
    expect(exitCodeFor(mk({ pruned: 5 }))).toBe(0);
  });

  it('real: partial (pruned > 0 && failed > 0) → 1', () => {
    expect(exitCodeFor(mk({ pruned: 3, failed: 1 }))).toBe(1);
  });

  it('real: total failure (pruned == 0 && failed > 0) → 2', () => {
    expect(exitCodeFor(mk({ failed: 2 }))).toBe(2);
  });

  it('real: all skipped counts as clean → 0', () => {
    expect(exitCodeFor(mk({ skipped: 5 }))).toBe(0);
  });

  it('dry-run: nothing to do → 0', () => {
    expect(exitCodeFor(mk({ dryRun: true }))).toBe(0);
  });

  it('dry-run: with candidates → 0 (verification, not a real failure)', () => {
    expect(exitCodeFor(mk({ dryRun: true, wouldPrune: 5 }))).toBe(0);
  });
});

describe('reasonForPruneFailure', () => {
  it('maps a generic Error to db_error', () => {
    expect(reasonForPruneFailure(new Error('boom'))).toBe('db_error');
  });

  it('maps a non-Error throwable to db_error', () => {
    expect(reasonForPruneFailure('plain string')).toBe('db_error');
    expect(reasonForPruneFailure(undefined)).toBe('db_error');
  });

  it('maps a named error class to its name', () => {
    class MyTransientError extends Error {
      constructor() {
        super('connection reset');
        this.name = 'TransientError';
      }
    }
    expect(reasonForPruneFailure(new MyTransientError())).toBe('TransientError');
  });
});

describe('runPrune — dry-run', () => {
  let repo: FakeRunPruneRepository;
  beforeEach(() => {
    repo = new FakeRunPruneRepository();
  });

  it('enumerates via listPrunable and never calls pruneRun', async () => {
    const rows = [
      makeRow('r1', 'succeeded', new Date('2026-01-01T00:00:00Z')),
      makeRow('r2', 'failed', new Date('2026-02-01T00:00:00Z')),
    ];
    repo.pages = [{ items: rows, nextCursor: null }];
    const buf = makeSummaryBuffer();

    const summary = await runPrune({
      repository: repo as unknown as RunPruneRepository,
      tenantId: TENANT,
      cutoff: new Date('2026-09-01T00:00:00Z'),
      batchSize: 100,
      dryRun: true,
      stdout: buf.stream,
    });

    expect(repo.pruneCalls).toEqual([]);
    expect(summary.dryRun).toBe(true);
    expect(summary.wouldPrune).toBe(2);
    expect(exitCodeFor(summary)).toBe(0);
    expect(buf.text()).toContain('[dry-run] would-prune r1');
    expect(buf.text()).toContain('[dry-run] would-prune r2');
    expect(buf.text()).toContain('would-prune: 2');
  });

  it('paginates via the keyset cursor across multiple pages', async () => {
    const page1 = {
      items: [makeRow('r1', 'succeeded', new Date('2026-01-01T00:00:00Z'))],
      nextCursor: 'cursor-1',
    };
    const page2 = {
      items: [makeRow('r2', 'failed', new Date('2026-02-01T00:00:00Z'))],
      nextCursor: null,
    };
    repo.pages = [page1, page2];
    const buf = makeSummaryBuffer();

    const summary = await runPrune({
      repository: repo as unknown as RunPruneRepository,
      tenantId: TENANT,
      cutoff: new Date('2026-09-01T00:00:00Z'),
      batchSize: 100,
      dryRun: true,
      stdout: buf.stream,
    });

    expect(repo.listCalls.length).toBe(2);
    expect(repo.listCalls[0]?.opts.cursor).toBeUndefined();
    expect(repo.listCalls[1]?.opts.cursor).toBe('cursor-1');
    expect(summary.wouldPrune).toBe(2);
    expect(buf.text()).toContain('would-prune r1');
    expect(buf.text()).toContain('would-prune r2');
  });
});

describe('runPrune — real run', () => {
  let repo: FakeRunPruneRepository;
  beforeEach(() => {
    repo = new FakeRunPruneRepository();
  });

  it('calls pruneRun per row and prints the summary', async () => {
    const rows = [
      makeRow('r1', 'succeeded', new Date('2026-01-01T00:00:00Z')),
      makeRow('r2', 'failed', new Date('2026-02-01T00:00:00Z')),
    ];
    repo.pages = [{ items: rows, nextCursor: null }];
    const buf = makeSummaryBuffer();

    const summary = await runPrune({
      repository: repo as unknown as RunPruneRepository,
      tenantId: TENANT,
      cutoff: new Date('2026-09-01T00:00:00Z'),
      batchSize: 100,
      dryRun: false,
      stdout: buf.stream,
    });

    expect(repo.pruneCalls.map((c) => c.id)).toEqual(['r1', 'r2']);
    expect(summary.pruned).toBe(2);
    expect(summary.failed).toBe(0);
    expect(exitCodeFor(summary)).toBe(0);
    expect(buf.text()).toContain('pruned r1');
    expect(buf.text()).toContain('pruned r2');
    expect(buf.text()).toContain('pruned: 2');
  });

  it('counts a not-found outcome (compare-and-set defence) as skipped', async () => {
    const rows = [makeRow('r1', 'succeeded', new Date('2026-01-01T00:00:00Z'))];
    repo.pages = [{ items: rows, nextCursor: null }];
    repo.pruneOutcomes.set('r1', {
      outcome: 'not-found',
      id: 'r1',
      status: null,
      finishedAt: null,
    });
    const buf = makeSummaryBuffer();

    const summary = await runPrune({
      repository: repo as unknown as RunPruneRepository,
      tenantId: TENANT,
      cutoff: new Date('2026-09-01T00:00:00Z'),
      batchSize: 100,
      dryRun: false,
      stdout: buf.stream,
    });

    expect(summary.pruned).toBe(0);
    expect(summary.skipped).toBe(1);
    expect(summary.failed).toBe(0);
    expect(exitCodeFor(summary)).toBe(0);
    expect(buf.text()).toContain('skipped r1');
  });

  it('counts a thrown pruneRun as failed and continues', async () => {
    const rows = [
      makeRow('r1', 'succeeded', new Date('2026-01-01T00:00:00Z')),
      makeRow('r2', 'failed', new Date('2026-02-01T00:00:00Z')),
    ];
    repo.pages = [{ items: rows, nextCursor: null }];
    class TransientError extends Error {
      constructor() {
        super('connection reset');
        this.name = 'TransientError';
      }
    }
    repo.pruneThrows.set('r1', new TransientError());
    const { logger, events } = captureLogger();
    const buf = makeSummaryBuffer();

    const summary = await runPrune({
      repository: repo as unknown as RunPruneRepository,
      tenantId: TENANT,
      cutoff: new Date('2026-09-01T00:00:00Z'),
      batchSize: 100,
      dryRun: false,
      stdout: buf.stream,
      logger: logger as never,
    });

    expect(summary.pruned).toBe(1);
    expect(summary.failed).toBe(1);
    expect(exitCodeFor(summary)).toBe(1); // partial: pruned>0 && failed>0
    expect(buf.text()).toContain('failed  r1');
    expect(buf.text()).toContain('TransientError');

    // Logged as a typed run_prune_failed event with structured fields.
    const failureEvents = events.filter((e) => e.msg === 'run_prune_failed');
    expect(failureEvents).toHaveLength(1);
    expect(failureEvents[0]?.payload['event']).toBe('run_prune_failed');
    expect(failureEvents[0]?.payload['tenant_id']).toBe(TENANT);
    expect(failureEvents[0]?.payload['run_id']).toBe('r1');
  });

  it('all-failed real run exits 2', async () => {
    const rows = [makeRow('r1', 'failed', new Date('2026-02-01T00:00:00Z'))];
    repo.pages = [{ items: rows, nextCursor: null }];
    repo.pruneThrows.set('r1', new Error('boom'));
    const buf = makeSummaryBuffer();

    const summary = await runPrune({
      repository: repo as unknown as RunPruneRepository,
      tenantId: TENANT,
      cutoff: new Date('2026-09-01T00:00:00Z'),
      batchSize: 100,
      dryRun: false,
      stdout: buf.stream,
    });

    expect(summary.pruned).toBe(0);
    expect(summary.failed).toBe(1);
    expect(exitCodeFor(summary)).toBe(2);
  });

  it('emits run_prune_started and run_prune_completed structured logs', async () => {
    repo.pages = [{ items: [], nextCursor: null }];
    const { logger, events } = captureLogger();

    await runPrune({
      repository: repo as unknown as RunPruneRepository,
      tenantId: TENANT,
      cutoff: new Date('2026-09-01T00:00:00Z'),
      batchSize: 100,
      dryRun: true,
      stdout: makeSummaryBuffer().stream,
      logger: logger as never,
    });

    const started = events.find((e) => e.msg === 'run_prune_started');
    const completed = events.find((e) => e.msg === 'run_prune_completed');
    expect(started).toBeDefined();
    expect(completed).toBeDefined();
    expect(started?.payload['event']).toBe('run_prune_started');
    expect(started?.payload['tenant_id']).toBe(TENANT);
    expect(typeof started?.payload['cutoff']).toBe('string');
    expect(started?.payload['dry_run']).toBe(true);
    expect(completed?.payload['event']).toBe('run_prune_completed');
    expect(typeof completed?.payload['duration_ms']).toBe('number');
  });

  it('never-log invariant: logger fields contain only identifiers and counts', async () => {
    repo.pages = [
      {
        items: [
          makeRow('r1', 'failed', new Date('2026-02-01T00:00:00Z')),
        ],
        nextCursor: null,
      },
    ];
    repo.pruneThrows.set('r1', new Error('something with secrets in it: AKIA...'));
    const { logger, events } = captureLogger();

    await runPrune({
      repository: repo as unknown as RunPruneRepository,
      tenantId: TENANT,
      cutoff: new Date('2026-09-01T00:00:00Z'),
      batchSize: 100,
      dryRun: false,
      stdout: makeSummaryBuffer().stream,
      logger: logger as never,
    });

    const failureEvent = events.find((e) => e.msg === 'run_prune_failed');
    expect(failureEvent).toBeDefined();
    // No raw error message, no plaintext credentials — only structured fields.
    const payload = JSON.stringify(failureEvent?.payload);
    expect(payload).not.toContain('AKIA');
    expect(payload).not.toContain('secrets');
  });
});

// `CliArgumentError` re-exported for tests
export type { CliArgumentError };
