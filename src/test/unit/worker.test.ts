/**
 * Unit tests for the worker loop, driven with an in-memory fake queue.
 *
 * These prove the *orchestration* — claim → verify → dispatch → settle → stop —
 * without a database and without asserting anything about PostgreSQL locking (that
 * is the integration suite's job, against a real server). What matters here is the
 * behaviour that must hold regardless of storage:
 *
 *   - a job is completed only when the dispatcher reported success, and a step
 *     that failed, refused, or cannot execute is never marked done;
 *   - a job whose run has vanished is failed with a clear reason and never dispatched;
 *   - the worker stamps its instance id on every claim and on every settlement, so
 *     a settlement it no longer owns is refused rather than applied;
 *   - shutdown is bounded on every path: it stops claiming, waits for the in-flight
 *     job up to its timeout, then hands back the lease it still owns — and it never
 *     rejects, whatever the queue does.
 */

import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ClaimedJob,
  EnqueueInput,
  JobError,
  Queue,
  ReapResult,
  ReleaseResult,
} from "@/domain/queue.js";
import { InvalidJobTransitionError } from "@/domain/queue.js";
import {
  DEFAULT_LEASE_MS,
  DEFAULT_WORKER_SHUTDOWN_TIMEOUT_MS,
  MAX_LEGITIMATE_STEP_DURATION_MS,
} from "@/domain/timing.js";
import {
  StepExecutionNotImplementedError,
  StepFailedError,
  StepRetryError,
  UnimplementedStepDispatcher,
} from "@/worker/dispatcher.js";
import type { StepDispatcher } from "@/worker/dispatcher.js";
import { WorkerHeartbeat } from "@/worker/heartbeat.js";
import { Worker } from "@/worker/worker.js";

const silentLogger = pino({ level: "silent" });

const claimedJob = (overrides: Partial<ClaimedJob> = {}): ClaimedJob => ({
  id: "job-1",
  tenantId: "tenant-a",
  runId: "run-1",
  stepKey: "first",
  attempt: 0,
  retryCount: 0,
  maxAttempts: 5,
  lockedBy: "worker-test",
  leaseExpiresAt: new Date(Date.now() + 60_000),
  ...overrides,
});

/** A queue that hands out a pre-seeded list of jobs and records settlements. */
class FakeQueue implements Queue {
  private readonly pending: ClaimedJob[];
  readonly completed: string[] = [];
  readonly failed: Array<{ id: string; workerId: string; error: JobError }> =
    [];
  readonly retried: Array<{
    id: string;
    workerId: string;
    error: JobError;
    runAt: Date;
  }> = [];
  readonly released: Array<{ id: string; workerId: string }> = [];
  claimedBy: string[] = [];
  releaseResult: ReleaseResult = { outcome: "released" };

  constructor(pending: ClaimedJob[] = []) {
    this.pending = [...pending];
  }

  enqueue(_input: EnqueueInput): Promise<{ id: string }> {
    return Promise.resolve({ id: "enqueued" });
  }

  claim(workerId: string): Promise<ClaimedJob | null> {
    this.claimedBy.push(workerId);
    return Promise.resolve(this.pending.shift() ?? null);
  }

  complete(jobId: string, _workerId: string): Promise<void> {
    this.completed.push(jobId);
    return Promise.resolve();
  }

  fail(jobId: string, workerId: string, error: JobError): Promise<void> {
    this.failed.push({ id: jobId, workerId, error });
    return Promise.resolve();
  }

  retry(
    jobId: string,
    workerId: string,
    error: JobError,
    runAt: Date,
  ): Promise<void> {
    this.retried.push({ id: jobId, workerId, error, runAt });
    return Promise.resolve();
  }

  release(jobId: string, workerId: string): Promise<ReleaseResult> {
    this.released.push({ id: jobId, workerId });
    return Promise.resolve(this.releaseResult);
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
    shutdownTimeoutMs: number;
    logger: typeof silentLogger;
  }> = {},
): Worker =>
  new Worker({
    queue,
    dispatcher: overrides.dispatcher ?? new UnimplementedStepDispatcher(),
    logger: overrides.logger ?? silentLogger,
    workerId: overrides.workerId ?? "worker-test",
    pollIntervalMs: 5,
    runExists: overrides.runExists ?? (() => Promise.resolve(true)),
    ...(overrides.shutdownTimeoutMs !== undefined
      ? { shutdownTimeoutMs: overrides.shutdownTimeoutMs }
      : {}),
  });

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function capturingLogger(): {
  logger: typeof silentLogger;
  records: () => Record<string, unknown>[];
} {
  let buffer = "";
  const stream = {
    write: (chunk: string) => {
      buffer += chunk;
      return true;
    },
  };
  return {
    logger: pino(
      { level: "trace" },
      stream as unknown as pino.DestinationStream,
    ),
    records: () =>
      buffer
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Worker.pollOnce", () => {
  it("returns false and dispatches nothing when the queue is empty", async () => {
    const queue = new FakeQueue([]);
    const dispatch = vi.fn(() => Promise.resolve());
    const worker = makeWorker(queue, { dispatcher: { dispatch } });
    worker.start();

    await expect(worker.pollOnce()).resolves.toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
    await worker.stop();
  });

  it("fails a claimed job whose step cannot execute — and never completes it", async () => {
    const queue = new FakeQueue([claimedJob()]);
    const worker = makeWorker(queue); // default: UnimplementedStepDispatcher
    worker.start();

    await expect(worker.pollOnce()).resolves.toBe(true);

    expect(queue.completed).toEqual([]); // the load-bearing assertion
    expect(queue.failed).toHaveLength(1);
    expect(queue.failed[0]!.id).toBe("job-1");
    expect(queue.failed[0]!.error.code).toBe("step_execution_not_implemented");
    expect(queue.failed[0]!.workerId).toBe("worker-test");
    await worker.stop();
  });

  it("fails a job whose run does not exist, without dispatching it", async () => {
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
    expect(queue.failed[0]!.error.code).toBe("run_not_found");
    await worker.stop();
  });

  it("completes a job only when the dispatcher reports success", async () => {
    const queue = new FakeQueue([claimedJob()]);
    // A stand-in for the Step 6 executor: it actually "runs" the step.
    const worker = makeWorker(queue, {
      dispatcher: { dispatch: () => Promise.resolve() },
    });
    worker.start();

    await worker.pollOnce();

    expect(queue.completed).toEqual(["job-1"]);
    expect(queue.failed).toEqual([]);
    await worker.stop();
  });

  it("fails a job — never completes it — when the engine reports a step failure", async () => {
    const queue = new FakeQueue([claimedJob()]);
    const reason = { code: "step_execution_error", message: "handler blew up" };
    const worker = makeWorker(queue, {
      dispatcher: {
        dispatch: () => Promise.reject(new StepFailedError(reason)),
      },
    });
    worker.start();

    await worker.pollOnce();

    expect(queue.completed).toEqual([]); // a failed step is never marked done
    expect(queue.failed).toHaveLength(1);
    expect(queue.failed[0]!.id).toBe("job-1");
    expect(queue.failed[0]!.error).toEqual(reason);
    expect(queue.failed[0]!.workerId).toBe("worker-test");
    await worker.stop();
  });

  it("retries a job — never completes or fails it — when the engine signals a retry", async () => {
    const queue = new FakeQueue([claimedJob({ retryCount: 1 })]);
    const reason = {
      code: "llm_rate_limited",
      message: "slow down",
      retryable: true,
    };
    const runAt = new Date(Date.now() + 4_000);
    const worker = makeWorker(queue, {
      dispatcher: {
        dispatch: () => Promise.reject(new StepRetryError(reason, runAt)),
      },
    });
    worker.start();

    await worker.pollOnce();

    // A retried job is neither completed nor failed — it goes back to pending.
    expect(queue.completed).toEqual([]);
    expect(queue.failed).toEqual([]);
    expect(queue.retried).toHaveLength(1);
    expect(queue.retried[0]!.id).toBe("job-1");
    expect(queue.retried[0]!.error).toEqual(reason);
    expect(queue.retried[0]!.runAt).toEqual(runAt);
    expect(queue.retried[0]!.workerId).toBe("worker-test");
    await worker.stop();
  });

  it("leaves the job untouched on an unexpected dispatcher error (reaper will recover it)", async () => {
    const queue = new FakeQueue([claimedJob()]);
    const worker = makeWorker(queue, {
      dispatcher: { dispatch: () => Promise.reject(new Error("boom")) },
    });
    worker.start();

    await worker.pollOnce();

    // Neither completed nor failed: the lease will lapse and the reaper requeues it.
    expect(queue.completed).toEqual([]);
    expect(queue.failed).toEqual([]);
    await worker.stop();
  });

  it("logs a lost-lease settlement refusal instead of an unexpected error", async () => {
    const { logger, records } = capturingLogger();
    const queue = new FakeQueue([claimedJob()]);
    // Another worker re-claimed the row while this step ran, so the ownership-
    // guarded `complete` matches nothing and the queue refuses the transition.
    queue.complete = (jobId) =>
      Promise.reject(new InvalidJobTransitionError(jobId, "completed"));
    const worker = makeWorker(queue, {
      logger,
      dispatcher: { dispatch: () => Promise.resolve() },
    });
    worker.start();

    await worker.pollOnce();

    expect(
      records().some((record) => record.msg === "job_settlement_not_owned"),
    ).toBe(true);
    expect(
      records().some((record) => record.msg === "job_processing_error"),
    ).toBe(false);
    expect(queue.failed).toEqual([]); // losing a lease is not a step failure
    await worker.stop();
  });

  it("stamps the worker instance id on every claim", async () => {
    const queue = new FakeQueue([]);
    const worker = makeWorker(queue, { workerId: "worker-xyz" });
    worker.start();

    await worker.pollOnce();

    expect(queue.claimedBy).toContain("worker-xyz");
    await worker.stop();
  });

  it("claims nothing once stopped", async () => {
    const queue = new FakeQueue([claimedJob()]);
    const worker = makeWorker(queue);
    worker.start();
    await worker.stop();

    const before = queue.claimedBy.length;
    await expect(worker.pollOnce()).resolves.toBe(false);
    expect(queue.claimedBy.length).toBe(before);
  });
});

describe("Worker.stop", () => {
  it("uses defaults that bound shutdown and keep the lease above the current max step duration", () => {
    expect(DEFAULT_WORKER_SHUTDOWN_TIMEOUT_MS).toBe(10_000);
    expect(DEFAULT_LEASE_MS).toBeGreaterThan(MAX_LEGITIMATE_STEP_DURATION_MS);
  });

  it("stops claiming new jobs once shutdown begins", async () => {
    const queue = new FakeQueue([
      claimedJob({ id: "job-1" }),
      claimedJob({ id: "job-2" }),
    ]);
    const gate = deferred<void>();
    const worker = makeWorker(queue, {
      shutdownTimeoutMs: 1_000,
      dispatcher: { dispatch: () => gate.promise },
    });

    worker.start();
    await vi.runOnlyPendingTimersAsync();

    const stopPromise = worker.stop();
    await vi.advanceTimersByTimeAsync(500);
    expect(queue.claimedBy).toHaveLength(1);

    gate.resolve();
    await stopPromise;
    expect(queue.claimedBy).toEqual(["worker-test"]);
    expect(queue.completed).toEqual(["job-1"]);
  });

  it("waits for an in-flight job that finishes before the shutdown timeout", async () => {
    const queue = new FakeQueue([claimedJob()]);
    const gate = deferred<void>();
    const worker = makeWorker(queue, {
      shutdownTimeoutMs: 1_000,
      dispatcher: { dispatch: () => gate.promise },
    });

    worker.start();
    await vi.runOnlyPendingTimersAsync();

    const stopPromise = worker.stop();
    expect(queue.released).toEqual([]);

    gate.resolve();
    await stopPromise;

    expect(queue.completed).toEqual(["job-1"]);
    expect(queue.released).toEqual([]);
  });

  it("returns after the shutdown timeout instead of waiting forever, and releases the lease it still owns", async () => {
    const queue = new FakeQueue([claimedJob()]);
    const gate = deferred<void>();
    const worker = makeWorker(queue, {
      shutdownTimeoutMs: 50,
      dispatcher: { dispatch: () => gate.promise },
    });

    worker.start();
    await vi.runOnlyPendingTimersAsync();

    const stopPromise = worker.stop();
    await vi.advanceTimersByTimeAsync(50);
    await stopPromise;

    expect(queue.released).toEqual([{ id: "job-1", workerId: "worker-test" }]);
    expect(queue.completed).toEqual([]);

    // The late completion path still runs, but the ownership-safe queue API will
    // reject it in the real queue instead of settling another worker's lease.
    gate.resolve();
  });

  it("logs the shutdown timeout and skips release when the worker no longer owns the lease", async () => {
    const { logger, records } = capturingLogger();
    const queue = new FakeQueue([claimedJob()]);
    queue.releaseResult = { outcome: "not_owned", lockedBy: "worker-new" };
    const gate = deferred<void>();
    const worker = makeWorker(queue, {
      logger,
      shutdownTimeoutMs: 25,
      dispatcher: { dispatch: () => gate.promise },
    });

    worker.start();
    await vi.runOnlyPendingTimersAsync();

    const stopPromise = worker.stop();
    await vi.advanceTimersByTimeAsync(25);
    await stopPromise;

    expect(
      records().some((record) => record.msg === "worker_shutdown_timed_out"),
    ).toBe(true);
    expect(
      records().some(
        (record) =>
          record.msg === "worker_lease_release_skipped" &&
          record.outcome === "not_owned" &&
          record.locked_by === "worker-new",
      ),
    ).toBe(true);

    gate.resolve();
  });

  it("does not reject when the lease release fails — shutdown still completes", async () => {
    const { logger, records } = capturingLogger();
    const queue = new FakeQueue([claimedJob()]);
    queue.release = () => Promise.reject(new Error("connection reset"));
    const gate = deferred<void>();
    const worker = makeWorker(queue, {
      logger,
      shutdownTimeoutMs: 25,
      dispatcher: { dispatch: () => gate.promise },
    });

    worker.start();
    await vi.runOnlyPendingTimersAsync();

    const stopPromise = worker.stop();
    await vi.advanceTimersByTimeAsync(25);
    // A failed release must not reject `stop()`: main.ts still has to stop the
    // reaper and close the pool. The reaper recovers the job when its lease lapses.
    await expect(stopPromise).resolves.toBeUndefined();

    expect(
      records().some((record) => record.msg === "worker_lease_release_failed"),
    ).toBe(true);
    expect(records().some((record) => record.msg === "worker_shutdown")).toBe(
      true,
    );

    gate.resolve();
  });

  it("returns even when the claim itself never settles, with no lease to release", async () => {
    const { logger, records } = capturingLogger();
    const queue = new FakeQueue([claimedJob()]);
    // A `claim` that never resolves. There is no claimed job to hand back, and the
    // wait must still be bounded — the process has to be able to terminate.
    queue.claim = () => new Promise<ClaimedJob | null>(() => undefined);
    const worker = makeWorker(queue, { logger, shutdownTimeoutMs: 30 });

    worker.start();
    await vi.runOnlyPendingTimersAsync();

    const stopPromise = worker.stop();
    await vi.advanceTimersByTimeAsync(30);
    await expect(stopPromise).resolves.toBeUndefined();

    expect(queue.released).toEqual([]);
    expect(
      records().some((record) => record.msg === "worker_shutdown_timed_out"),
    ).toBe(true);
    expect(records().some((record) => record.msg === "worker_shutdown")).toBe(
      true,
    );
  });
});

describe("Worker → heartbeat wiring", () => {
  // The WorkerHeartbeat unit tests cover the state machine and counters in
  // isolation. These tests instead prove the *call sites* in worker.ts actually
  // invoke the right heartbeat method on each settlement path — successful
  // claim/complete, terminal failure, lost-lease settlement refusal, and
  // unexpected processing errors — and that the lifecycle hooks fire in order.
  // Real WorkerHeartbeat instances are attached; the assertions read the
  // snapshot, not mocks.
  function buildWithHeartbeat(
    queue: Queue,
    overrides: Partial<{
      dispatcher: StepDispatcher;
      runExists: (tenantId: string, runId: string) => Promise<boolean>;
      workerId: string;
      shutdownTimeoutMs: number;
    }> = {},
  ): { worker: Worker; heartbeat: WorkerHeartbeat } {
    const heartbeat = new WorkerHeartbeat();
    const worker = new Worker({
      queue,
      dispatcher: overrides.dispatcher ?? new UnimplementedStepDispatcher(),
      logger: silentLogger,
      workerId: overrides.workerId ?? "worker-test",
      pollIntervalMs: 5,
      runExists: overrides.runExists ?? (() => Promise.resolve(true)),
      ...(overrides.shutdownTimeoutMs !== undefined
        ? { shutdownTimeoutMs: overrides.shutdownTimeoutMs }
        : {}),
      heartbeat,
    });
    return { worker, heartbeat };
  }

  it("A. successful claim invokes recordClaimed (claimed++; distinct from completed)", async () => {
    const queue = new FakeQueue([claimedJob()]);
    const { worker, heartbeat } = buildWithHeartbeat(queue, {
      dispatcher: { dispatch: () => Promise.resolve() },
    });
    worker.start();

    // Before any work: nothing has been claimed yet.
    expect(heartbeat.snapshot().counts.claimed).toBe(0);

    await worker.pollOnce();

    // recordClaimed fires inside pollOnce the moment a job is returned from
    // queue.claim(...). This assertion is distinct from test B's
    // `counts.completed`: a worker that never recorded the claim would still
    // record the completion if recordCompleted were still wired, so each call
    // site needs its own wiring assertion.
    expect(heartbeat.snapshot().counts.claimed).toBe(1);
    expect(heartbeat.snapshot().counts.completed).toBe(1);
    expect(heartbeat.snapshot().inFlight).toBe(0);
    await worker.stop();
  });

  it("B. successful completion sets recordCompleted (completed++, inFlight=0)", async () => {
    const queue = new FakeQueue([claimedJob()]);
    const { worker, heartbeat } = buildWithHeartbeat(queue, {
      dispatcher: { dispatch: () => Promise.resolve() },
    });
    worker.start();

    await worker.pollOnce();

    // The happy path through Worker.handle() calls recordCompleted, which is
    // the *only* settlement that bumps this counter.
    expect(queue.completed).toEqual(["job-1"]);
    expect(heartbeat.snapshot().counts.completed).toBe(1);
    expect(heartbeat.snapshot().counts.failed).toBe(0);
    expect(heartbeat.snapshot().counts.released).toBe(0);
    expect(heartbeat.snapshot().inFlight).toBe(0);
    await worker.stop();
  });

  it("C. terminal failure (StepFailedError) sets recordFailed (failed++, inFlight=0)", async () => {
    const queue = new FakeQueue([claimedJob()]);
    const reason = { code: "step_execution_error", message: "handler blew up" };
    const { worker, heartbeat } = buildWithHeartbeat(queue, {
      dispatcher: {
        dispatch: () => Promise.reject(new StepFailedError(reason)),
      },
    });
    worker.start();

    await worker.pollOnce();

    // Worker.handle() routes a StepFailedError through queue.fail(...) and
    // bumps recordFailed — never recordCompleted, never recordReleased.
    expect(queue.failed).toHaveLength(1);
    expect(heartbeat.snapshot().counts.failed).toBe(1);
    expect(heartbeat.snapshot().counts.completed).toBe(0);
    expect(heartbeat.snapshot().counts.released).toBe(0);
    expect(heartbeat.snapshot().inFlight).toBe(0);
    await worker.stop();
  });

  it("D. lost-lease settlement refusal (InvalidJobTransitionError) sets recordReleased", async () => {
    const queue = new FakeQueue([claimedJob()]);
    // Another worker re-claimed the row mid-step: the ownership-guarded
    // `complete` rejects with InvalidJobTransitionError. Worker.handle catches
    // this in the explicit settlement-refusal branch (it is NOT a processing
    // error) and records `released`.
    queue.complete = (jobId) =>
      Promise.reject(new InvalidJobTransitionError(jobId, "completed"));
    const { worker, heartbeat } = buildWithHeartbeat(queue, {
      dispatcher: { dispatch: () => Promise.resolve() },
    });
    worker.start();

    await worker.pollOnce();

    expect(heartbeat.snapshot().counts.released).toBe(1);
    expect(heartbeat.snapshot().counts.completed).toBe(0);
    expect(heartbeat.snapshot().counts.failed).toBe(0);
    expect(heartbeat.snapshot().inFlight).toBe(0);
    await worker.stop();
  });

  it("E. unexpected processing error sets recordReleased (lease left to lapse, reaper recovers)", async () => {
    const queue = new FakeQueue([claimedJob()]);
    const { worker, heartbeat } = buildWithHeartbeat(queue, {
      dispatcher: { dispatch: () => Promise.reject(new Error("boom")) },
    });
    worker.start();

    await worker.pollOnce();

    // Neither completed nor failed: the lease will lapse and the reaper
    // reclaims the job. The handler still records `released` so the in-flight
    // slot clears and the snapshot reflects the work this worker actually did.
    expect(queue.completed).toEqual([]);
    expect(queue.failed).toEqual([]);
    expect(heartbeat.snapshot().counts.released).toBe(1);
    expect(heartbeat.snapshot().counts.completed).toBe(0);
    expect(heartbeat.snapshot().counts.failed).toBe(0);
    expect(heartbeat.snapshot().inFlight).toBe(0);
    await worker.stop();
  });

  it("F. lifecycle wiring: start→starting, tick→running, stop→stopped", async () => {
    const queue = new FakeQueue([claimedJob()]);
    const { worker, heartbeat } = buildWithHeartbeat(queue, {
      dispatcher: { dispatch: () => Promise.resolve() },
    });

    // Fresh heartbeat before start(): never_started.
    expect(heartbeat.snapshot().state).toBe("never_started");

    worker.start();
    // start() invokes heartbeat.start(), promoting state to 'starting'.
    // The scheduled tick at delay 0 has not fired yet under fake timers.
    expect(heartbeat.snapshot().state).toBe("starting");

    // Drain the scheduled tick. tick() calls heartbeat.tick() at entry — this
    // is what promotes 'starting' to 'running' — then awaits the full
    // pollOnce cycle. After it resolves: claimed++, completed++, inFlight=0.
    await vi.runOnlyPendingTimersAsync();
    expect(heartbeat.snapshot().state).toBe("running");
    expect(heartbeat.snapshot().counts.claimed).toBe(1);
    expect(heartbeat.snapshot().counts.completed).toBe(1);
    expect(heartbeat.snapshot().inFlight).toBe(0);

    // stop() invokes markStopping, drains (nothing in flight), then markStopped.
    // The end state is 'stopped' — distinctly different from 'running'.
    await worker.stop();
    expect(heartbeat.snapshot().state).toBe("stopped");
    expect(heartbeat.snapshot().state).not.toBe("running");
  });
});

describe("UnimplementedStepDispatcher", () => {
  it("refuses every step with a specific error", async () => {
    const dispatcher = new UnimplementedStepDispatcher();
    await expect(dispatcher.dispatch(claimedJob())).rejects.toBeInstanceOf(
      StepExecutionNotImplementedError,
    );
  });
});
