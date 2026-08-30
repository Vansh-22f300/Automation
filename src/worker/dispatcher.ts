/**
 * The step-execution seam.
 *
 * The worker's job is queue mechanics: claim, dispatch, settle. *What* it means
 * to execute a step is deliberately behind this interface, so that Step 6 (the
 * real executor: resolve the step from the pinned definition, run it, persist
 * its output, enqueue the next job) drops in by providing a new `StepDispatcher`
 * — the worker loop does not change.
 *
 * Until that executor exists there is nothing that can legitimately run a user's
 * step. The MVP dispatcher is therefore honest about it: it refuses, loudly and
 * specifically, rather than pretending. The worker treats that refusal as a
 * terminal, clearly-labelled failure of the job — never as success. Marking a
 * job `done` when no work happened would be the one genuinely dangerous
 * outcome (a run silently declared complete), and this makes it impossible.
 */

import type { ClaimedJob } from '@/domain/queue.js';
import type { JobError } from '@/domain/queue.js';

/** Executes the step a claimed job names. Implemented for real in Step 6. */
export interface StepDispatcher {
  dispatch(job: ClaimedJob): Promise<void>;
}

/**
 * Raised by the real dispatcher when a step's execution *failed* — as opposed to
 * could not be attempted. By the time this is thrown the engine has already
 * recorded the failure durably (the step run and the workflow run are marked
 * `failed` in their own committed transaction); the error exists only to tell the
 * worker to settle the queue job as `failed` rather than `done`. It carries the
 * same structured, log-safe reason that was persisted, so the queue's `last_error`
 * matches the run's.
 *
 * Distinct from an *unexpected* error (a dropped connection mid-execution): those
 * are left to propagate untyped so the worker leaves the job `running` for the
 * reaper, rather than burning it as a terminal failure.
 */
export class StepFailedError extends Error {
  readonly code = 'step_failed';
  readonly reason: JobError;

  constructor(reason: JobError) {
    const code = typeof reason.code === 'string' ? reason.code : 'step_failed';
    super(`step execution failed (${code})`);
    this.name = 'StepFailedError';
    this.reason = reason;
    Error.captureStackTrace(this, StepFailedError);
  }
}

/**
 * Raised by the real dispatcher when a step failed with a *retryable* error and
 * business retry budget remains. Like `StepFailedError`, the engine has already
 * committed the durable record of this attempt (the `workflow_step_runs` row is
 * `failed`) — but crucially it did NOT mark the workflow run failed: the run
 * stays `running` so the deferred re-execution resumes it. The error tells the
 * worker to move the queue job `running → pending` with a future `run_at` (via
 * `queue.retry`) instead of settling it terminally.
 *
 * It carries the same structured reason that was persisted, plus the computed
 * `runAt` — the instant before which the job must not be re-claimed. The engine
 * owns the timing (it consulted the retry policy); the worker only executes the
 * transition.
 */
export class StepRetryError extends Error {
  readonly code = 'step_retry';
  readonly reason: JobError;
  readonly runAt: Date;

  constructor(reason: JobError, runAt: Date) {
    const code = typeof reason.code === 'string' ? reason.code : 'step_retry';
    super(`step execution failed retryably (${code}); scheduled for retry`);
    this.name = 'StepRetryError';
    this.reason = reason;
    this.runAt = runAt;
    Error.captureStackTrace(this, StepRetryError);
  }
}

/**
 * Raised by a dispatcher that cannot execute steps yet. The worker recognises
 * this exact type and records it as a job failure with a clear reason, distinct
 * from an unexpected crash.
 */
export class StepExecutionNotImplementedError extends Error {
  readonly code = 'step_execution_not_implemented';

  constructor(stepKey: string) {
    super(`step execution is not implemented yet (step "${stepKey}"); deferred to Step 6`);
    this.name = 'StepExecutionNotImplementedError';
    Error.captureStackTrace(this, StepExecutionNotImplementedError);
  }
}

/**
 * The Step 5 dispatcher: refuses every step. It exists to prove the queue
 * hand-off end to end (a job is claimed, verified, and settled) without
 * fabricating any step execution.
 */
export class UnimplementedStepDispatcher implements StepDispatcher {
  dispatch(job: ClaimedJob): Promise<void> {
    return Promise.reject(new StepExecutionNotImplementedError(job.stepKey));
  }
}
