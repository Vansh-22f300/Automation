/**
 * How long a step may legitimately take — and therefore how long the queue lease
 * and graceful shutdown must be.
 *
 * A lease is the queue's promise that no other worker will touch a claimed row
 * for a while. If a step can legitimately run *longer* than that promise, the
 * reaper hands the same job to a second worker while the first is still working:
 * duplicated external side effects, and two workers racing to settle one row.
 * The lease is therefore not a taste question but an invariant:
 *
 *     DEFAULT_LEASE_MS > MAX_LEGITIMATE_STEP_DURATION_MS + LEASE_SAFETY_MARGIN_MS
 *
 * DERIVATION, from the code as it stands today. Every input below mirrors a real
 * constant elsewhere in the tree; `src/test/unit/timing.test.ts` compares them
 * and fails if one drifts.
 *
 * An `llm` step is the longest step type there is, and its cost is bounded by
 * the tool loop in `domain/step-handler.ts`:
 *
 *   - at most MAX_TOOL_ROUNDS_BUDGET provider rounds (`MAX_TOOL_ROUNDS_LIMIT` in
 *     `domain/workflow-definition.ts` — a per-step `max_tool_rounds` cannot
 *     exceed it);
 *   - each round is exactly one Claude HTTP request, because the provider is
 *     built with `maxRetries: 0`, bounded by LLM_ROUND_TIMEOUT_BUDGET_MS
 *     (`DEFAULT_TIMEOUT_MS` in `llm/claude-provider.ts`);
 *   - a round that asks for tools runs its tool calls sequentially, each one an
 *     HTTP request bounded by TOOL_CALL_TIMEOUT_BUDGET_MS
 *     (`DEFAULT_SLACK_TIMEOUT_MS` in `connectors/slack/slack-client.ts`, enforced
 *     with a real `AbortController`);
 *   - plus STEP_OVERHEAD_BUDGET_MS for everything that is not an outbound
 *     request: the handful of statements the engine runs inside the step's
 *     transaction, pool wait, credential decryption, schema validation.
 *
 *     5 × (60s + 4 × 10s) + 60s = 560s = 9m20s
 *
 * THE ONE INPUT THAT IS A BUDGET RATHER THAN A BOUND: nothing in our code caps
 * how many tool calls a model may request in a single round. The loop executes
 * whatever the provider returned, one after another, so the true tail is (calls
 * the model emitted) × 10s per round, limited only by `max_output_tokens`.
 * TOOL_CALLS_PER_ROUND_BUDGET is a deliberate, documented assumption — a
 * per-round cap belongs with the tool loop, not with the lease. The lease below
 * absorbs roughly eight calls per round before the invariant is threatened.
 *
 * This module deliberately imports NOTHING. It is depended on by `config/env.ts`
 * and by the queue, and must not drag the Anthropic SDK or the Slack transport
 * into every process that merely parses configuration.
 */

/** One Claude round: a single HTTP request, no SDK-level retries. */
export const LLM_ROUND_TIMEOUT_BUDGET_MS = 60_000;

/** One tool call: a single Slack HTTP request, aborted at this deadline. */
export const TOOL_CALL_TIMEOUT_BUDGET_MS = 10_000;

/** The hard ceiling on provider rounds in one `llm` step. */
export const MAX_TOOL_ROUNDS_BUDGET = 5;

/**
 * Tool calls assumed per tool-use round. An assumption, not a guarantee — see
 * the caveat above.
 */
export const TOOL_CALLS_PER_ROUND_BUDGET = 4;

/** Everything in a step that is not an outbound HTTP request. */
export const STEP_OVERHEAD_BUDGET_MS = 60_000;

/** The worst-case duration of one legitimate step under the budgets above. */
export const MAX_LEGITIMATE_STEP_DURATION_MS =
  MAX_TOOL_ROUNDS_BUDGET *
    (LLM_ROUND_TIMEOUT_BUDGET_MS +
      TOOL_CALLS_PER_ROUND_BUDGET * TOOL_CALL_TIMEOUT_BUDGET_MS) +
  STEP_OVERHEAD_BUDGET_MS;

/**
 * Head-room the lease keeps above the worst case, for clock skew between worker
 * and database, the gap between stamping a lease and starting the step, and a
 * reaper sweep landing at the worst possible moment (it runs every 30s).
 *
 * Deliberately generous: it is what makes the invariant test *sensitive*. Raise
 * any budget above and the test fails loudly instead of quietly eating margin.
 */
export const LEASE_SAFETY_MARGIN_MS = 5 * 60 * 1_000;

/** The smallest lease that satisfies the invariant. */
export const MIN_SAFE_LEASE_MS = MAX_LEGITIMATE_STEP_DURATION_MS + LEASE_SAFETY_MARGIN_MS;

/**
 * The lease every claim is granted: 15 minutes — above MIN_SAFE_LEASE_MS, and a
 * round number an operator can hold in their head. Not configurable per job: a
 * lease that a caller could shorten is a lease that cannot be reasoned about.
 */
export const DEFAULT_LEASE_MS = 15 * 60 * 1_000;

/**
 * How long graceful shutdown waits for one in-flight job before giving up,
 * releasing the lease it still owns, and returning.
 *
 * Ten seconds, matching the API's existing shutdown grace. It is deliberately
 * *far* below both the step budget and the lease: the point is not to let the
 * step finish (it may have minutes of provider timeout left) but to stop the
 * process from waiting forever, so a supervisor's SIGKILL never arrives first.
 * Operators override it with `WORKER_SHUTDOWN_TIMEOUT_MS`.
 */
export const DEFAULT_WORKER_SHUTDOWN_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// External-effect lease
// ---------------------------------------------------------------------------
//
// A second, much shorter lease guards a single *external effect* (one tool call
// reaching outside the system — see `tool_effects` and the effect ledger). It is
// NOT the queue lease: the queue lease bounds a whole job (up to a 9m20s step),
// whereas the effect lease bounds the reserve → connector-call → settle window
// around one external call. Its job is to answer, when a second attempt finds a
// reservation still `pending`: "is an attempt still working on this effect
// (defer), or did one die holding it (ambiguous)?"
//
// THE INVARIANT (verified by `src/test/unit/timing.test.ts`):
//
//     TOOL_CALL_TIMEOUT_BUDGET_MS  <  DEFAULT_EFFECT_LEASE_MS  <  DEFAULT_LEASE_MS
//              (10s, one connector call)   (120s)                   (15m, job lease)
//
// - The lower bound (10s < 120s) is what makes the lease *meaningful*. The
//   connector caps a single call with an `AbortController` at 10s, and the
//   executor settles the effect the moment that call returns — so in every
//   healthy path the reservation settles far inside its lease. A lease at or
//   below the connector timeout could expire while a legitimate call is still in
//   flight, and a second attempt would conclude "crashed / ambiguous" about an
//   effect that was simply still running: false ambiguity, and lost recoverable
//   work. 120s clears 10s by more than 10×, absorbing GC pauses, pool waits and
//   a slow settlement commit.
// - The upper bound (120s < 15m) keeps the effect lease strictly shorter than
//   the job that owns it. There is no point asserting an attempt still holds an
//   effect for longer than the job could itself survive; and it guarantees a
//   crashed attempt's effect lease expires (→ recoverable as ambiguous) well
//   before its job lease would even be reaped.
//
// Deliberately NOT configurable per call, for the same reason the queue lease is
// not: a lease a caller could shorten is a lease that cannot be reasoned about.

/**
 * The lease a single external-effect reservation is granted: 120 seconds. Sits
 * an order of magnitude above one connector call (10s) and well below the job
 * lease (15m) — see the invariant above.
 */
export const DEFAULT_EFFECT_LEASE_MS = 120_000;

/**
 * Extra buffer a deferring attempt waits *past* a live reservation's lease
 * horizon before it re-checks the ledger.
 *
 * When an attempt finds an effect `pending` with a still-live lease (another
 * attempt is working it), it does not touch the row — it reschedules its own job
 * for `(lease_expires_at − now) + EFFECT_SETTLEMENT_MARGIN_MS`. Because there is
 * no lease renewal, one deferral must land *after* the owner has either settled
 * the effect or crashed and let the lease lapse; the margin is the safety gap on
 * top of the lease horizon that absorbs settlement-commit latency and worker/DB
 * clock skew, so the deferring attempt never wakes up racing the lease expiry.
 *
 * This is an ADDITIVE buffer, not a term inside the lease invariant above: it is
 * added to the *remaining* lease, so it is by design free to exceed the lease
 * itself. Its only hard requirement is to be positive. 110s comfortably clears
 * the 30s statement/idle-in-transaction timeouts that bound a settlement commit.
 */
export const EFFECT_SETTLEMENT_MARGIN_MS = 110_000;
