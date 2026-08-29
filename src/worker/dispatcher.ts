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

/** Executes the step a claimed job names. Implemented for real in Step 6. */
export interface StepDispatcher {
  dispatch(job: ClaimedJob): Promise<void>;
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
