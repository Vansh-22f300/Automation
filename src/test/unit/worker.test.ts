/**
 * Unit tests for the worker loop, driven with an in-memory fake queue.
 *
 * These prove the *orchestration* — claim → verify → dispatch → settle — without
 * a database and without asserting anything about PostgreSQL locking (that is
 * the integration suite's job, against a real server). What matters here is the
 * behaviour that must hold regardless of storage:
 *
 *   - a claimed job whose step cannot execute yet is failed, never completed;
 *   - a job whose run has vanished is failed with a clear reason and never dispatched;
 *   - the worker stamps its instance id on every claim;
 *   - an empty queue is a no-op;
 *   - once stopped, the worker claims nothing further.
 *
 * The single most important assertion across all of them: the worker never calls
 * `complete` in Step 5, because no work is ever really performed.
 */

import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';

import type { ClaimedJob, EnqueueInput, JobError, Queue, ReapResult } from '@/domain/queue.js';
import { StepExecutionNotImplementedError, StepFailedError, StepRetryError, UnimplementedStepDispatcher } from '@/worker/dispatcher.js';
import type { StepDispatcher } from '@/worker/dispatcher.js';
import { Worker } from '@/worker/worker.js';

const silentLogger = pino({ level: 'silent' });

const claimedJob = (overrides: Partial<ClaimedJob> = {}): ClaimedJob => ({
  id: 'job-1',
  tenantId: 'tenant-a',
  runId: 'run-1',
  stepKey: 'first',
  attempt: 0,
  retryCount: 0,
  maxAttempts: 5,
  lockedBy: 'worker-test',
  leaseExpiresAt: new Date(Date.now() + 60_000),
  ...overrides,
});

/** A queue that hands out a pre-seeded list of jobs and records settlements. */
class FakeQueue implements Queue {
  private readonly pending: ClaimedJob[];
  readonly completed: string[] = [];
  readonly failed: Array<{ id: string; error: JobError }> = [];
  readonly retried: Array<{ id: string; error: JobError; runAt: Date }> = [];
  claimedBy: string[] = [];

  constructor(pending: ClaimedJob[] = []) {
    this.pending = [...pending];
  }

  enqueue(_input: EnqueueInput): Promise<{ id: string }> {
    return Promise.resolve({ id: 'enqueued' });
  }

  claim(workerId: string): Promise<ClaimedJob | null> {
    this.claimedBy.push(workerId);
    return Promise.resolve(this.pending.shift() ?? null);
  }

  complete(jobId: string): Promise<void> {
    this.completed.push(jobId);
    return Promise.resolve();
  }

  fail(jobId: string, error: JobError): Promise<void> {
    this.failed.push({ id: jobId, error });
    return Promise.resolve();
  }

  retry(jobId: string, error: JobError, runAt: Date): Promise<void> {
    this.retried.push({ id: jobId, error, runAt });
    return Promise.resolve();
  }

  requeueExpired(): Promise<ReapResult> {
    return Promise.resolve({ requeued: 0, deadLettered: [] });
  }
}

const makeWorker = (
  queue: Queue,
  overrides: Partial<{
    dispatcher: StepDispatcher;
    runExists: (tenantId: string, runId: string) => Promise<boolean>;
    workerId: string;
  }> = {},
): Worker =>
  new Worker({
    queue,
    dispatcher: overrides.dispatcher ?? new UnimplementedStepDispatcher(),
    logger: silentLogger,
    workerId: overrides.workerId ?? 'worker-test',
    pollIntervalMs: 5,
    runExists: overrides.runExists ?? (() => Promise.resolve(true)),
  });

describe('Worker.pollOnce', () => {
  it('returns false and dispatches nothing when the queue is empty', async () => {
    const queue = new FakeQueue([]);
    const dispatch = vi.fn(() => Promise.resolve());
    const worker = makeWorker(queue, { dispatcher: { dispatch } });
    worker.start();

    await expect(worker.pollOnce()).resolves.toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
    await worker.stop();
  });

  it('fails a claimed job whose step cannot execute — and never completes it', async () => {
    const queue = new FakeQueue([claimedJob()]);
    const worker = makeWorker(queue); // default: UnimplementedStepDispatcher
    worker.start();

    await expect(worker.pollOnce()).resolves.toBe(true);

    expect(queue.completed).toEqual([]); // the load-bearing assertion
    expect(queue.failed).toHaveLength(1);
    expect(queue.failed[0]!.id).toBe('job-1');
    expect(queue.failed[0]!.error.code).toBe('step_execution_not_implemented');
    await worker.stop();
  });

  it('fails a job whose run does not exist, without dispatching it', async () => {
    const queue = new FakeQueue([claimedJob()]);
    const dispatch = vi.fn(() => Promise.resolve());
    const worker = makeWorker(queue, {
      dispatcher: { dispatch },
      runExists: () => Promise.resolve(false),
    });
    worker.start();

    await worker.pollOnce();

    expect(dispatch).not.toHaveBeenCalled();
    expect(queue.completed).toEqual([]);
    expect(queue.failed[0]!.error.code).toBe('run_not_found');
    await worker.stop();
  });

  it('completes a job only when the dispatcher reports success', async () => {
    const queue = new FakeQueue([claimedJob()]);
    // A stand-in for the Step 6 executor: it actually "runs" the step.
    const worker = makeWorker(queue, { dispatcher: { dispatch: () => Promise.resolve() } });
    worker.start();

    await worker.pollOnce();

    expect(queue.completed).toEqual(['job-1']);
    expect(queue.failed).toEqual([]);
    await worker.stop();
  });

  it('fails a job — never completes it — when the engine reports a step failure', async () => {
    const queue = new FakeQueue([claimedJob()]);
    const reason = { code: 'step_execution_error', message: 'handler blew up' };
    const worker = makeWorker(queue, {
      dispatcher: { dispatch: () => Promise.reject(new StepFailedError(reason)) },
    });
    worker.start();

    await worker.pollOnce();

    expect(queue.completed).toEqual([]); // a failed step is never marked done
    expect(queue.failed).toHaveLength(1);
    expect(queue.failed[0]!.id).toBe('job-1');
    expect(queue.failed[0]!.error).toEqual(reason);
    await worker.stop();
  });

  it('retries a job — never completes or fails it — when the engine signals a retry', async () => {
    const queue = new FakeQueue([claimedJob({ retryCount: 1 })]);
    const reason = { code: 'llm_rate_limited', message: 'slow down', retryable: true };
    const runAt = new Date(Date.now() + 4_000);
    const worker = makeWorker(queue, {
      dispatcher: { dispatch: () => Promise.reject(new StepRetryError(reason, runAt)) },
    });
    worker.start();

    await worker.pollOnce();

    // A retried job is neither completed nor failed — it goes back to pending.
    expect(queue.completed).toEqual([]);
    expect(queue.failed).toEqual([]);
    expect(queue.retried).toHaveLength(1);
    expect(queue.retried[0]!.id).toBe('job-1');
    expect(queue.retried[0]!.error).toEqual(reason);
    expect(queue.retried[0]!.runAt).toEqual(runAt);
    await worker.stop();
  });

  it('leaves the job untouched on an unexpected dispatcher error (reaper will recover it)', async () => {
    const queue = new FakeQueue([claimedJob()]);
    const worker = makeWorker(queue, {
      dispatcher: { dispatch: () => Promise.reject(new Error('boom')) },
    });
    worker.start();

    await worker.pollOnce();

    // Neither completed nor failed: the lease will lapse and the reaper requeues it.
    expect(queue.completed).toEqual([]);
    expect(queue.failed).toEqual([]);
    await worker.stop();
  });

  it('stamps the worker instance id on every claim', async () => {
    const queue = new FakeQueue([]);
    const worker = makeWorker(queue, { workerId: 'worker-xyz' });
    worker.start();

    await worker.pollOnce();

    expect(queue.claimedBy).toContain('worker-xyz');
    await worker.stop();
  });

  it('claims nothing once stopped', async () => {
    const queue = new FakeQueue([claimedJob()]);
    const worker = makeWorker(queue);
    worker.start();
    await worker.stop();

    const before = queue.claimedBy.length;
    await expect(worker.pollOnce()).resolves.toBe(false);
    expect(queue.claimedBy.length).toBe(before);
  });
});

describe('UnimplementedStepDispatcher', () => {
  it('refuses every step with a specific error', async () => {
    const dispatcher = new UnimplementedStepDispatcher();
    await expect(dispatcher.dispatch(claimedJob())).rejects.toBeInstanceOf(
      StepExecutionNotImplementedError,
    );
  });
});
