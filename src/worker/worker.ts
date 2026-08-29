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
 *   - stop cleanly: once shutting down it claims no new work and lets the
 *     in-flight op finish.
 *
 * Crucially it never marks a job `done` unless the dispatcher reported success.
 * In Step 5 the dispatcher always refuses, so no job is ever falsely completed.
 */

import { withContext } from '@/observability/logger.js';
import type { Logger } from '@/observability/logger.js';
import type { ClaimedJob, Queue } from '@/domain/queue.js';
import { StepExecutionNotImplementedError, StepFailedError } from '@/worker/dispatcher.js';
import type { StepDispatcher } from '@/worker/dispatcher.js';

/** Confirms a run exists for a tenant. The worker's "is this job valid?" check. */
export type RunExistenceCheck = (tenantId: string, runId: string) => Promise<boolean>;

export interface WorkerOptions {
  readonly queue: Queue;
  readonly dispatcher: StepDispatcher;
  readonly logger: Logger;
  /** Stable identity of this worker instance, stamped onto leases and logs. */
  readonly workerId: string;
  /** How long to wait after finding no work before polling again. */
  readonly pollIntervalMs: number;
  readonly runExists: RunExistenceCheck;
}

export class Worker {
  private readonly queue: Queue;
  private readonly dispatcher: StepDispatcher;
  private readonly logger: Logger;
  private readonly workerId: string;
  private readonly pollIntervalMs: number;
  private readonly runExists: RunExistenceCheck;

  private running = false;
  private timer: NodeJS.Timeout | undefined;
  /** The current tick, so shutdown can wait for a lightweight op to finish. */
  private inFlight: Promise<void> = Promise.resolve();

  constructor(options: WorkerOptions) {
    this.queue = options.queue;
    this.dispatcher = options.dispatcher;
    this.logger = options.logger.child({ worker_id: options.workerId });
    this.workerId = options.workerId;
    this.pollIntervalMs = options.pollIntervalMs;
    this.runExists = options.runExists;
  }

  /** Begin polling. Returns immediately; the loop runs on timers. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.logger.info({ poll_interval_ms: this.pollIntervalMs }, 'worker_started');
    this.scheduleNext(0);
  }

  /**
   * Stop accepting new work and wait for any in-flight op to settle. Idempotent.
   * After this resolves the worker holds no lease it is actively renewing and
   * has claimed nothing new.
   */
  async stop(): Promise<void> {
    if (!this.running) {
      await this.inFlight;
      return;
    }
    this.running = false;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.inFlight;
    this.logger.info('worker_shutdown');
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
    const log = withContext(this.logger, {
      tenant_id: job.tenantId,
      run_id: job.runId,
    }).child({ job_id: job.id, step_key: job.stepKey, attempt: job.attempt });

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
      await this.queue.complete(job.id);
      log.info('job_completed');
    } catch (error) {
      if (error instanceof StepFailedError) {
        // The step ran and failed. The engine has already recorded the step run
        // and the workflow run as failed in their own committed transaction; all
        // that remains is to settle the queue job as failed with the same reason.
        // Terminal: no reaper retry (a real retry policy is Step 11).
        await this.settleFailed(log, job, error.reason);
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
      // Genuinely unexpected (e.g. a dropped connection mid-execution). Do not
      // complete, do not fail: leave the job `running` so its lease expires and
      // the reaper returns it to `pending` for a fresh attempt. Nothing is
      // corrupted and nothing is swallowed.
      log.error({ err: error }, 'job_processing_error');
    }
  }

  private async settleFailed(
    log: Logger,
    job: ClaimedJob,
    error: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.queue.fail(job.id, error);
      log.warn({ reason: error.code }, 'job_failed');
    } catch (failError) {
      // The job could not be moved to failed (a lost lease, a race). Surface it;
      // the reaper will reclaim the row if its lease lapses.
      log.error({ err: failError }, 'job_fail_transition_failed');
    }
  }
}
