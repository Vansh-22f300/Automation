/**
 * The workflow-run state machine.
 *
 * A run's `status` is not free to change however a caller likes: the legal
 * transitions are a small, explicit graph, and every status change the engine
 * makes is checked against it. Centralising the rule here — rather than scattering
 * `if (status === …)` checks through the engine — means an illegal transition is
 * one clearly-named error raised in one place, and adding a future state
 * (`waiting`, `cancelled` handling) is an edit to this table, not an archaeology
 * expedition through the executor.
 *
 * The set of statuses is defined by the `workflow_run_status` pg enum; this
 * module governs how a run may move *between* them.
 */

/** The run statuses, mirroring the `workflow_run_status` enum in the schema. */
export type RunStatus = 'queued' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'cancelled';

/** The terminal statuses: once here, a run never transitions again. */
export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ['succeeded', 'failed', 'cancelled'];

/**
 * The legal transitions out of each status. Step 6 exercises only
 * `queued → running`, `running → succeeded` and `running → failed`; the rest are
 * declared now so the graph is complete and future steps (waiting on an external
 * signal, cancellation) slot in without re-reasoning the whole machine.
 */
const ALLOWED_TRANSITIONS: Record<RunStatus, readonly RunStatus[]> = {
  queued: ['running', 'failed', 'cancelled'],
  running: ['running', 'waiting', 'succeeded', 'failed', 'cancelled'],
  waiting: ['running', 'failed', 'cancelled'],
  succeeded: [],
  failed: [],
  cancelled: [],
};

/** True if a run in `from` may legally move to `to`. */
export function canTransitionRun(from: RunStatus, to: RunStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/** True if `status` is terminal — no further transition is permitted. */
export function isTerminalRunStatus(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.includes(status);
}

/**
 * Raised when a run is asked to make a transition the state machine forbids —
 * e.g. advancing a run that already `succeeded`. Distinct from an infrastructure
 * failure: it means the engine's view of the run is stale or a caller tried
 * something illegal, not that the database is unreachable.
 */
export class InvalidRunTransitionError extends Error {
  readonly code = 'invalid_run_transition';
  readonly from: RunStatus;
  readonly to: RunStatus;

  constructor(from: RunStatus, to: RunStatus) {
    super(`illegal workflow-run transition ${from} → ${to}`);
    this.name = 'InvalidRunTransitionError';
    this.from = from;
    this.to = to;
    Error.captureStackTrace(this, InvalidRunTransitionError);
  }
}

/** Assert a transition is legal, or throw `InvalidRunTransitionError`. */
export function assertRunTransition(from: RunStatus, to: RunStatus): void {
  if (!canTransitionRun(from, to)) {
    throw new InvalidRunTransitionError(from, to);
  }
}
