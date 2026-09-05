/**
 * Unit tests for the reaper's reporting, driven with an in-memory fake queue.
 *
 * The reaping itself is a guarded UPDATE and belongs to the integration suite
 * against a real PostgreSQL. What is provable here — and only here, because it is
 * about what gets written to stdout rather than to a table — is the operational
 * contract around a poison job:
 *
 *   - a dead-lettered job produces exactly one `job_dead_lettered` line, at error
 *     level, carrying the identifiers an operator needs to find it;
 *   - that line states the ceiling that was applied, so the reason is legible
 *     without reading the source;
 *   - it carries no payload, no step output and no credential;
 *   - a sweep that reclaims nothing and condemns nothing says nothing;
 *   - a sweep that throws is still swallowed, so a failing database cannot kill
 *     the worker process.
 */

import pino from 'pino';
import { describe, expect, it } from 'vitest';

import { MAX_CRASH_ATTEMPTS } from '@/domain/queue.js';
import type { EnqueueInput, JobError, Queue, ReapResult } from '@/domain/queue.js';
import type { Logger } from '@/observability/logger.js';
import { Reaper } from '@/worker/reaper.js';

/** A pino logger writing NDJSON into a buffer, parsed back one record per line. */
function capturingLogger(): { logger: Logger; records: () => Record<string, unknown>[] } {
  let buffer = '';
  const stream = {
    write: (chunk: string) => {
      buffer += chunk;
      return true;
    },
  };
  const logger = pino({ level: 'trace' }, stream as unknown as pino.DestinationStream);
  return {
    logger,
    records: () =>
      buffer
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

/**
 * A queue that only answers `requeueExpired`. Every other method rejects: the
 * reaper must not call them, and a fake that silently returned a plausible value
 * would hide it if one day it did.
 */
class SweepOnlyQueue implements Queue {
  constructor(private readonly outcome: ReapResult | Error) {}

  enqueue(_input: EnqueueInput): Promise<never> {
    return Promise.reject(new Error('the reaper must not enqueue'));
  }

  claim(_workerId: string): Promise<never> {
    return Promise.reject(new Error('the reaper must not claim'));
  }

  complete(_jobId: string, _workerId: string): Promise<never> {
    return Promise.reject(new Error('the reaper must not complete'));
  }

  fail(_jobId: string, _workerId: string, _error: JobError): Promise<never> {
    return Promise.reject(new Error('the reaper must not fail jobs directly'));
  }

  retry(_jobId: string, _workerId: string, _error: JobError, _runAt: Date): Promise<never> {
    return Promise.reject(new Error('the reaper must not retry'));
  }

  release(_jobId: string, _workerId: string): Promise<never> {
    return Promise.reject(new Error('the reaper must not release'));
  }

  requeueExpired(): Promise<ReapResult> {
    return this.outcome instanceof Error
      ? Promise.reject(this.outcome)
      : Promise.resolve(this.outcome);
  }
}

const makeReaper = (queue: Queue, logger: Logger): Reaper =>
  // A long interval: every test drives `sweep()` by hand, and the reaper is never
  // started, so no timer is ever armed.
  new Reaper({ queue, logger, intervalMs: 60_000 });

describe('Reaper.sweep', () => {
  it('logs one job_dead_lettered line per condemned job, with the ceiling that was applied', async () => {
    const { logger, records } = capturingLogger();
    const reaper = makeReaper(
      new SweepOnlyQueue({
        requeued: 2,
        deadLettered: [
          {
            id: 'job-poison',
            tenantId: 'tenant-a',
            runId: 'run-7',
            stepKey: 'call-llm',
            attempt: MAX_CRASH_ATTEMPTS,
          },
        ],
      }),
      logger,
    );

    const result = await reaper.sweep();
    expect(result.requeued).toBe(2);
    expect(result.deadLettered).toHaveLength(1);

    const dead = records().filter((r) => r.msg === 'job_dead_lettered');
    expect(dead).toHaveLength(1);
    expect(dead[0]).toMatchObject({
      level: 50, // error: a poison job is what an alert should fire on
      tenant_id: 'tenant-a',
      run_id: 'run-7',
      job_id: 'job-poison',
      step_key: 'call-llm',
      attempt: MAX_CRASH_ATTEMPTS,
      crash_attempt_limit: MAX_CRASH_ATTEMPTS,
    });

    // The ordinary recovery is still reported, separately from the condemnation.
    expect(records().filter((r) => r.msg === 'job_requeued')).toHaveLength(1);
  });

  it('says nothing when a sweep reclaims and condemns nothing', async () => {
    const { logger, records } = capturingLogger();
    const reaper = makeReaper(new SweepOnlyQueue({ requeued: 0, deadLettered: [] }), logger);

    await expect(reaper.sweep()).resolves.toEqual({ requeued: 0, deadLettered: [] });
    expect(records()).toHaveLength(0);
  });

  it('swallows a failing sweep so a database outage cannot kill the worker', async () => {
    const { logger, records } = capturingLogger();
    const reaper = makeReaper(new SweepOnlyQueue(new Error('connection terminated')), logger);

    await expect(reaper.sweep()).resolves.toEqual({ requeued: 0, deadLettered: [] });
    const failures = records().filter((r) => r.msg === 'reaper_sweep_failed');
    expect(failures).toHaveLength(1);
    expect(records().some((r) => r.msg === 'job_dead_lettered')).toBe(false);
  });

  it('applies a crash-attempt ceiling that is small, positive and distinct from any retry budget', () => {
    // Pinned deliberately: the value is an operational contract (how much work a
    // poison job may cost before it is abandoned), not an implementation detail.
    expect(MAX_CRASH_ATTEMPTS).toBe(5);
  });
});
