/**
 * The effect ledger — the domain seam for making an external effect (one tool
 * call that reaches outside the system) survivable across job retries and worker
 * crashes, WITHOUT pretending to exactly-once semantics it cannot deliver.
 *
 * This module is pure: an interface, its value types, and two dependency-free
 * classification functions. The persistence (atomic reservation, CAS settlement)
 * lives in `@/repositories/effect-ledger-repository`; the wiring into a tool call
 * lives in `@/domain/tool-executor`. Splitting it this way keeps the DECISION
 * (what an error means for an effect) unit-testable with no database, and confines
 * the CONCURRENCY (the one uniqueness constraint that arbitrates duplicate
 * attempts) to the repository that can be proven against real PostgreSQL.
 *
 * --- The problem, precisely ---
 *
 * The execution engine runs a step handler OUTSIDE any database transaction (the
 * two-transaction model). A tool call inside that handler has already produced its
 * external effect by the time control returns. Two distinct failure shapes make a
 * naive job retry unsafe:
 *
 *   1. Lost settlement. The effect succeeded, but the process died before the
 *      success was durably recorded. The job is redelivered; without a ledger the
 *      effect runs a SECOND time.
 *   2. Concurrent duplicate. A job's lease expired (the worker stalled, did not
 *      die), the reaper handed the job to a second worker, and two workers now run
 *      the same tool call at once.
 *
 * The ledger closes both by making ONE database uniqueness constraint
 * (`tenant_id, idempotency_key`) the sole concurrency boundary. Every attempt
 * reserves with a single atomic `INSERT … ON CONFLICT DO NOTHING RETURNING`:
 * exactly one attempt wins the row, the rest observe it and branch on its state.
 *
 * --- What it deliberately does NOT do ---
 *
 * It is NOT exactly-once. Between "the external service accepted the effect" and
 * "we committed `succeeded`" there is an irreducible window; a crash inside it is
 * the `ambiguous` outcome — recorded and surfaced, never silently resent. The
 * honest guarantee is at-least-once with a safe-by-default unknown path.
 */

import { AmbiguousEffectError, PermanentError, RetryableError, isAppError } from '@/domain/errors.js';
import { EFFECT_SAFETY_DETAIL_KEY } from '@/domain/tool.js';
import type { EffectSafety } from '@/domain/tool.js';

/**
 * The trusted identity of one external effect. Every field originates from the
 * engine/handler (run, step, tool) or a platform counter — NEVER from the model,
 * the tool arguments, or an external payload.
 */
export interface EffectReservation {
  readonly tenantId: string;
  readonly runId: string;
  readonly stepKey: string;
  readonly toolName: string;
  /** Per-step monotonic index of this call across all rounds. Part of the key. */
  readonly ordinal: number;
  /** `<runId>:<stepKey>:<toolName>:<ordinal>` — the reservation key. */
  readonly idempotencyKey: string;
  /** The connector's provider, mirrored onto the row for inspection. */
  readonly provider: string;
  /** The acquiring attempt's `stepRunId`: the CAS owner token. */
  readonly owner: string;
  /** How long this attempt's reservation lease lasts, in milliseconds. */
  readonly leaseMs: number;
}

/**
 * The normalised, non-secret record of a settled failure, stored so a later
 * attempt can re-throw the same classification. NEVER a token, header, credential,
 * prompt, or raw argument — only what re-throwing needs.
 */
export interface EffectErrorRecord {
  readonly code: string;
  readonly message: string;
  /** The original queue-retryability of the underlying failure, for inspection. */
  readonly retryable: boolean;
}

/**
 * The outcome of trying to acquire a reservation — a discriminated union the tool
 * executor branches on. Exactly one attempt ever gets `acquired` for a given key
 * while it holds the reservation; everyone else gets one of the observing states.
 *
 * - `acquired` — this attempt owns a fresh (or safely-released) reservation and
 *   MUST now call the connector and settle the result.
 * - `replay`   — the effect already succeeded; return the stored result, do NOT
 *   call the connector.
 * - `failed`   — the effect already failed permanently; re-throw the stored error,
 *   do NOT call the connector.
 * - `ambiguous`— the effect's outcome is unknowable (a prior attempt crashed
 *   holding it, or a prior ambiguous settlement); re-throw as
 *   {@link AmbiguousEffectError}, do NOT call the connector.
 * - `defer`    — another attempt holds a LIVE reservation right now; do not touch
 *   it. Reschedule this job for `retryAfterMs` (past the live lease horizon).
 */
export type EffectAcquisition =
  | { readonly kind: 'acquired' }
  | { readonly kind: 'replay'; readonly result: unknown }
  | { readonly kind: 'failed'; readonly error: EffectErrorRecord }
  | { readonly kind: 'ambiguous'; readonly error: EffectErrorRecord }
  | { readonly kind: 'defer'; readonly retryAfterMs: number };

/**
 * How a failed connector call must settle its reservation. Produced by the pure
 * {@link classifyEffectFailure} and consumed by the ledger's settlement.
 *
 * - `release`   — the connector GUARANTEED the external write did not happen
 *   (effect-safe). Return the reservation to `pending` with owner NULL so the next
 *   attempt may genuinely re-execute; re-throw the original retryable error so the
 *   queue schedules that retry.
 * - `permanent` — a deterministic failure; settle `failed`, store the error,
 *   re-throw the original permanent error.
 * - `ambiguous` — the outcome is unknown and the connector's recovery policy is
 *   `hold_ambiguous` (the only implemented policy); settle `ambiguous` (terminal),
 *   store the error, throw {@link AmbiguousEffectError}.
 */
export type EffectFailureDisposition =
  | { readonly kind: 'release'; readonly error: EffectErrorRecord }
  | { readonly kind: 'permanent'; readonly error: EffectErrorRecord }
  | { readonly kind: 'ambiguous'; readonly error: EffectErrorRecord };

/**
 * The persistence contract the tool executor drives. Tenant scoping is the
 * implementation's (a ledger is built per tenant), exactly like the connection
 * resolver — so no method takes a tenant parameter beyond what the reservation
 * already carries.
 */
export interface EffectLedger {
  /**
   * Atomically reserve the effect, or observe an existing reservation and return
   * what the caller must do. The sole concurrency boundary is the
   * `(tenant_id, idempotency_key)` uniqueness constraint — there is no
   * SELECT-before-INSERT, so two concurrent attempts cannot both acquire.
   */
  acquire(reservation: EffectReservation): Promise<EffectAcquisition>;

  /**
   * Settle a held reservation as `succeeded`, storing the normalised, non-secret
   * result for replay. Guarded on the owner token: a superseded attempt (its lease
   * expired and another attempt took over) settles nothing.
   */
  settleSuccess(reservation: EffectReservation, result: unknown): Promise<void>;

  /**
   * Settle a held reservation according to a {@link EffectFailureDisposition}.
   * Guarded on the owner token. `release` returns it to `pending` (owner NULL);
   * `permanent`/`ambiguous` are terminal.
   */
  settleFailure(reservation: EffectReservation, disposition: EffectFailureDisposition): Promise<void>;
}

/**
 * Read a connector error's effect-safety assertion, applying the fail-safe rule:
 * anything that is not EXPLICITLY `safe` is `ambiguous`. A missing tag, an
 * unrecognised value, a non-AppError — all collapse to `ambiguous`. This is the
 * single place that rule lives, so no caller can accidentally treat "untagged" as
 * safe.
 */
export function effectSafetyOf(error: unknown): EffectSafety {
  if (!isAppError(error)) return 'ambiguous';
  const tag = error.details?.[EFFECT_SAFETY_DETAIL_KEY];
  return tag === 'safe' ? 'safe' : 'ambiguous';
}

/** Reduce an AppError to the non-secret record stored in the ledger. */
function toErrorRecord(error: PermanentError | RetryableError): EffectErrorRecord {
  return { code: error.code, message: error.message, retryable: error.retryable };
}

/**
 * Classify a connector failure into how its reservation must settle — the heart
 * of the two-axis contract, and deliberately pure so it can be exhaustively
 * unit-tested with no database.
 *
 * The `recoveryPolicy` is the acquiring connector's declared policy (defaulting to
 * `hold_ambiguous` when absent). Only `hold_ambiguous` is implemented; the other
 * policies are recognised but, until their machinery exists, fall back to holding
 * — never to a silent resend.
 *
 *   PermanentError                     → permanent  (deterministic; settle failed)
 *   RetryableError + effectSafety=safe → release    (write did not happen; re-run)
 *   RetryableError + ambiguous/untagged→ ambiguous  (outcome unknown; hold)
 *   AmbiguousEffectError (defensive)   → ambiguous  (already unknowable)
 *   any non-AppError                   → ambiguous  (unrecognised = unsafe)
 */
export function classifyEffectFailure(
  error: unknown,
  recoveryPolicy: EffectRecoveryPolicyResolved = 'hold_ambiguous',
): EffectFailureDisposition {
  // A non-AppError escaping the connector is a crash we do not understand. We
  // cannot prove the effect did not happen, so it is ambiguous — never released.
  if (!isAppError(error)) {
    return {
      kind: 'ambiguous',
      error: {
        code: 'effect_connector_crashed',
        message: error instanceof Error ? error.message : String(error),
        retryable: false,
      },
    };
  }

  // Deterministic failure (includes AmbiguousEffectError, itself a PermanentError,
  // though the ledger never re-enters classification for one it already minted).
  if (!error.retryable) {
    // An already-ambiguous error stays ambiguous; any other permanent error is a
    // clean deterministic failure.
    if (error instanceof AmbiguousEffectError) {
      return { kind: 'ambiguous', error: toErrorRecord(error) };
    }
    return { kind: 'permanent', error: toErrorRecord(error) };
  }

  // Retryable. The ONLY path that may re-execute the effect: the connector
  // explicitly asserted the write did not happen.
  if (effectSafetyOf(error) === 'safe') {
    return { kind: 'release', error: toErrorRecord(error) };
  }

  // Retryable but ambiguous (or untagged). Consult the connector's recovery policy.
  // Only `hold_ambiguous` is implemented today; `resend_safe` and `reconcile` need
  // provider machinery that does not exist yet, so they HOLD too — the safe default
  // is never a silent resend. When that machinery lands, its branch goes here.
  switch (recoveryPolicy) {
    case 'resend_safe':
    case 'reconcile':
    case 'hold_ambiguous':
      return { kind: 'ambiguous', error: toErrorRecord(error) };
  }
}

/**
 * The recovery policies {@link classifyEffectFailure} understands. Kept as a local
 * alias (rather than importing the connector type) so the pure classifier has no
 * dependency beyond the error taxonomy; the executor maps a connector's
 * `recoveryPolicy` onto this, defaulting an absent one to `hold_ambiguous`.
 */
export type EffectRecoveryPolicyResolved = 'resend_safe' | 'reconcile' | 'hold_ambiguous';
