/**
 * The worker loop: claim a job, dispatch it, settle it — repeat.
 *
 * This is pure queue orchestration and nothing else. It does not know what a
 * step is (that is the `StepDispatcher`) nor how the queue is stored (that is
 * the `Queue`); both are injected, which is what lets this class be exercised in
 * full without a database. Its responsibilities are exactly:
 *
 *   - poll for work at a steady cadence, claiming one job at a time;
 *   - before dispatching, confirm the job's run actually exists — a job whose
 *     run has vanished is malformed and is failed with a clear reason, not run;
 *   - hand a valid job to the dispatcher and settle it: `complete` on success,
 *     `fail` on a recognised "cannot execute" refusal;
 *   - survive the unexpected — an infrastructure error while claiming, or a
 *     surprise thrown by the dispatcher — without corrupting queue state and
 *     without killing the process;
 *   - stop cleanly *and in bounded time*: once shutting down it claims no new
 *     work and waits for the in-flight job for at most `shutdownTimeoutMs`,
 *     after which it hands back the lease it still owns (see `stop`) rather than
 *     leaving the job `running` until the lease lapses.
 *
 * Crucially it never marks a job `done` unless the dispatcher reported success,
 * and it never settles a job whose lease it has lost: every queue call passes the
 * `lockedBy` it claimed with, so a late settlement from a worker that has already
 * been superseded is refused by the queue instead of overwriting the new owner.
 */

import { withContext } from '@/observability/logger.js';
import type { Logger } from '@/observability/logger.js';
import { InvalidJobTransitionError } from '@/domain/queue.js';
import type { ClaimedJob, Queue } from '@/domain/queue.js';
import { DEFAULT_WORKER_SHUTDOWN_TIMEOUT_MS } from '@/domain/timing.js';
import { StepExecutionNotImplementedError, StepFailedError, StepRetryError } from '@/worker/dispatcher.js';
import type { StepDispatcher } from '@/worker/dispatcher.js';

/** Confirms a run exists for a tenant. The worker's "is this job valid?" check. */
export type RunExistenceCheck = (tenantId: string, runId: string) => Promise<boolean>;

/**
 * The identifiers a job-scoped log line carries: enough to find the job, the run
 * and the tenant, and never a payload, a step output or a credential.
 */
const jobContext = (job: ClaimedJob): Record<string, string> => ({
  job_id: job.id,
  tenant_id: job.tenantId,
  run_id: job.runId,
  step_key: job.stepKey,
});

export interface WorkerOptions {
  readonly queue: Queue;
  readonly dispatcher: StepDispatcher;
  readonly logger: Logger;
  /** Stable identity of this worker instance, stamped onto leases and logs. */
  readonly workerId: string;
  /** How long to wait after finding no work before polling again. */
  readonly pollIntervalMs: number;
  readonly runExists: RunExistenceCheck;
  /** How long graceful shutdown waits for in-flight work before giving up. */
  readonly shutdownTimeoutMs?: number;
}

export class Worker {
  private readonly queue: Queue;
  private readonly dispatcher: StepDispatcher;
  private readonly logger: Logger;
  private readonly workerId: string;
  private readonly pollIntervalMs: number;
  private readonly runExists: RunExistenceCheck;
  private readonly shutdownTimeoutMs: number;

  private running = false;
  private timer: NodeJS.Timeout | undefined;
  /** The current tick, so shutdown can wait for a lightweight op to finish. */
  private inFlight: Promise<void> = Promise.resolve();
  /** The job this worker is actively processing, if any. */
  private currentJob: ClaimedJob | undefined;
  private stopPromise: Promise<void> | undefined;

  constructor(options: WorkerOptions) {
    this.queue = options.queue;
    this.dispatcher = options.dispatcher;
    this.logger = options.logger.child({ worker_id: options.workerId });
    this.workerId = options.workerId;
    this.pollIntervalMs = options.pollIntervalMs;
    this.runExists = options.runExists;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_WORKER_SHUTDOWN_TIMEOUT_MS;
  }

  /** Begin polling. Returns immediately; the loop runs on timers. */
  start(): void {
    if (this.running) return;
    this.running = true;
    // A restarted worker must be stoppable again; the memoized shutdown from the
    // previous lifecycle has already resolved and would otherwise be handed back.
    this.stopPromise = undefined;
    this.logger.info({ poll_interval_ms: this.pollIntervalMs }, 'worker_started');
    this.scheduleNext(0);
  }

  /**
   * Stop accepting new work, then wait for the in-flight job — but for no longer
   * than `shutdownTimeoutMs`. Idempotent, and never rejects.
   *
   * If the job settles in time, its own completion/failure handling stays
   * authoritative and shutdown adds nothing to it. If the wait runs out, the
   * worker *voluntarily hands back the lease it still owns*, so the job returns to
   * `pending` at once instead of sitting `running` until the lease lapses, and
   * `stop()` returns. The job is never marked failed: this worker giving up on
   * waiting says nothing about whether the step succeeded.
   *
   * What it cannot do is cancel the work. Neither an in-flight Claude request nor
   * a Slack call is abortable from here, so the step may still be running when
   * this resolves — possibly against a job another worker has since claimed. That
   * is safe only because every settling queue method is guarded on `locked_by`: a
   * late `complete`/`fail`/`retry` from a superseded worker matches no row and is
   * refused. External side effects stay at-least-once, exactly as before.
   */
  async stop(): Promise<void> {
    this.stopPromise ??= this.shutdown();
    return this.stopPromise;
  }

  /** The one-shot shutdown sequence behind `stop`. Bounded on every path. */
  private async shutdown(): Promise<void> {
    this.running = false;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }

    this.logger.info({ timeout_ms: this.shutdownTimeoutMs }, 'worker_shutdown_requested');

    const claimed = this.currentJob;
    if (claimed !== undefined) {
      this.logger.info(
        { ...jobContext(claimed), timeout_ms: this.shutdownTimeoutMs },
        'worker_shutdown_waiting',
      );
    }

    const settled = await this.drainInFlight();

    if (!settled) {
      // Re-read rather than trusting `claimed`: the job in flight when shutdown
      // began may have settled during the wait, and a tick already past its
      // `running` check may have claimed a different one after it. Whatever is held
      // *now* is what this worker would otherwise strand.
      const stranded = this.currentJob;
      this.logger.error(
        {
          timeout_ms: this.shutdownTimeoutMs,
          ...(stranded === undefined ? {} : jobContext(stranded)),
        },
        'worker_shutdown_timed_out',
      );
      // No job of ours in flight means the loop is wedged somewhere else — a
      // `claim` that never returns, say. There is no lease to hand back, so
      // returning is all we can do; the process watchdog in main.ts is the backstop.
      if (stranded !== undefined) await this.releaseLease(stranded);
    }

    this.logger.info('worker_shutdown');
  }

  /**
   * Wait for the current tick to finish, for at most `shutdownTimeoutMs`. True if
   * it finished, false if the wait ran out.
   *
   * It waits on the *tick* rather than on the dispatcher because the tick is what
   * owns settling the job, and waiting on it also covers a tick still inside
   * `claim`. A tick that rejects counts as finished: `tick` already handles its own
   * errors, and a surprise there must not turn `stop()` into a rejected promise.
   */
  private async drainInFlight(): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.inFlight.then(
          () => true,
          () => true,
        ),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), this.shutdownTimeoutMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      // Left armed, this would hold the event loop open for the full timeout on the
      // common path where the job settled first.
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * Hand a still-owned lease back to the queue so the job becomes immediately
   * re-claimable instead of waiting out its lease. Not a retry: nothing about the
   * job's history changes — no `attempt`, no `retry_count`, no `last_error`, and
   * `run_at` is preserved.
   *
   * Ownership-safety is the queue's, by construction: `release` only matches a row
   * that is still `running` *and* still locked by this worker, so a worker
   * superseded during its shutdown wait cannot disturb the new owner. Both refusals
   * are logged rather than treated as errors — they are expected outcomes of the race.
   *
   * Never throws. A release that fails leaves the job `running` with a lease that
   * will lapse, which is exactly the case the reaper recovers, and it must not abort
   * the rest of the shutdown sequence (the reaper stop and the pool close).
   */
  private async releaseLease(job: ClaimedJob): Promise<void> {
    const context = jobContext(job);
    this.logger.info(context, 'worker_lease_release_attempted');

    try {
      const result = await this.queue.release(job.id, job.lockedBy);
      if (result.outcome === 'released') {
        this.logger.warn(context, 'worker_lease_release_succeeded');
        return;
      }
      this.logger.warn(
        {
          ...context,
          outcome: result.outcome,
          ...(result.outcome === 'not_owned'
            ? { locked_by: result.lockedBy }
            : { status: result.status }),
        },
        'worker_lease_release_skipped',
      );
    } catch (error) {
      this.logger.error({ ...context, err: error }, 'worker_lease_release_failed');
    }
  }

  private scheduleNext(delayMs: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.inFlight = this.tick();
    }, delayMs);
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    try {
      const handled = await this.pollOnce();
      // Drain quickly while there is work; back off to the poll interval when idle.
      this.scheduleNext(handled ? 0 : this.pollIntervalMs);
    } catch (error) {
      // A claim failure is almost always transient (a dropped connection). Stay
      // alive and try again next tick; do not let it reach the process handlers.
      this.logger.error({ err: error }, 'worker_poll_failed');
      this.scheduleNext(this.pollIntervalMs);
    }
  }

  /**
   * Claim and process at most one job. Returns true if a job was handled, false
   * if the queue was empty. Exposed for tests to drive the loop deterministically.
   */
  async pollOnce(): Promise<boolean> {
    if (!this.running) return false;
    const job = await this.queue.claim(this.workerId);
    if (job === null) return false;
    await this.handle(job);
    return true;
  }

  private async handle(job: ClaimedJob): Promise<void> {
    this.currentJob = job;
    const log = withContext(this.logger, {
      tenant_id: job.tenantId,
      run_id: job.runId,
    }).child({ job_id: job.id, step_key: job.stepKey, attempt: job.attempt, retry_count: job.retryCount });

    log.info('job_claimed');

    // Validity: the run this job advances must exist. If it does not, the job is
    // malformed — record a clear, terminal failure rather than attempting it.
    const runExists = await this.runExists(job.tenantId, job.runId);
    if (!runExists) {
      await this.settleFailed(log, job, {
        code: 'run_not_found',
        message: 'job references a workflow run that does not exist',
      });
      return;
    }

    try {
      await this.dispatcher.dispatch(job);
      // The engine advanced the run by exactly one step (or recognised a stale
      // redelivery and did nothing). Either way this job's work is done.
      await this.queue.complete(job.id, job.lockedBy);
      log.info('job_completed');
    } catch (error) {
      if (error instanceof StepFailedError) {
        // The step ran and failed terminally. The engine has already recorded the
        // step run and the workflow run as failed in their own committed
        // transaction; all that remains is to settle the queue job as failed with
        // the same reason. No retry: either the failure was unretryable or its
        // business budget is exhausted (the engine made that call).
        await this.settleFailed(log, job, error.reason);
        return;
      }
      if (error instanceof StepRetryError) {
        // The step failed retryably with budget remaining. The engine left the run
        // `running` and recorded this attempt; move the queue job back to
        // `pending` with the computed future `run_at` so it is re-executed after
        // the backoff. Durable: the deferral lives on the row, not in memory.
        await this.settleRetry(log, job, error.reason, error.runAt);
        return;
      }
      if (error instanceof StepExecutionNotImplementedError) {
        // Legacy path (the Step 5 dispatcher): the step cannot run yet. Fail it
        // clearly and terminally — honest that no work was performed.
        await this.settleFailed(log, job, {
          code: error.code,
          message: error.message,
        });
        return;
      }
      if (error instanceof InvalidJobTransitionError) {
        // The queue refused to mark this job done: while the step was running this
        // worker's lease lapsed (or it was released at shutdown) and another worker
        // or the reaper took the row. That guard is the point — a superseded owner
        // must not settle a job it no longer holds — and the step's own effects were
        // already committed by the engine in their own transaction. Nothing to
        // repair; name it precisely instead of filing it as an unexpected error.
        log.warn({ err: error }, 'job_settlement_not_owned');
        return;
      }
      // Genuinely unexpected (e.g. a dropped connection mid-execution). Do not
      // complete, do not fail: leave the job `running` so its lease expires and
      // the reaper returns it to `pending` for a fresh attempt. Nothing is
      // corrupted and nothing is swallowed.
      log.error({ err: error }, 'job_processing_error');
    } finally {
      if (this.currentJob?.id === job.id && this.currentJob.lockedBy === job.lockedBy) {
        this.currentJob = undefined;
      }
    }
  }

  private async settleFailed(
    log: Logger,
    job: ClaimedJob,
    error: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.queue.fail(job.id, job.lockedBy, error);
      log.warn({ reason: error.code }, 'job_failed');
    } catch (failError) {
      // The job could not be moved to failed (a lost lease, a race). Surface it;
      // the reaper will reclaim the row if its lease lapses.
      log.error({ err: failError }, 'job_fail_transition_failed');
    }
  }

  private async settleRetry(
    log: Logger,
    job: ClaimedJob,
    reason: Record<string, unknown>,
    runAt: Date,
  ): Promise<void> {
    try {
      await this.queue.retry(job.id, job.lockedBy, reason, runAt);
      log.warn(
        { reason: reason.code, retry_count: job.retryCount, next_run_at: runAt.toISOString() },
        'job_retry_scheduled',
      );
    } catch (retryError) {
      // The job could not be moved back to pending (a lost lease, or the reaper
      // requeued it first). Surface it; the reaper will reclaim the row if its
      // lease lapses, so the retry is not lost — only its precise timing.
      log.error({ err: retryError }, 'job_retry_transition_failed');
    }
  }
}
