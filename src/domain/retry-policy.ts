/**
 * The business retry policy: how long to wait before re-running a step that
 * failed with a *retryable* error, and how many such retries are allowed.
 *
 * This module is pure and deterministic-given-`random`. It owns the *timing* of
 * a retry (the backoff curve) and nothing else: it does not know about jobs,
 * transactions, or the queue. The engine asks it "given this many prior business
 * retries, how many milliseconds should I defer the next attempt?" and turns the
 * answer into a future `run_at`. Because the delay is stored on the job row and
 * enforced by the queue's `run_at <= now()` claim predicate, retries are fully
 * durable — there is no `sleep()`, `setTimeout()`, or in-memory retry loop
 * anywhere in the system (a crash mid-wait loses nothing; the row still says
 * "not claimable until T").
 *
 * ## Two counters, one budget
 *
 * A job carries two independent counters (see `jobs` in the schema):
 *
 *   - `attempt`      — lease/crash recovery. The reaper increments it when it
 *                      returns an expired-lease job to `pending`. It measures how
 *                      many times a worker *died holding* the job, not how many
 *                      times the step logic failed.
 *   - `retry_count`  — business retries. This policy increments it (via the
 *                      queue's `retry`) when a step fails with a retryable error
 *                      and budget remains. It measures deliberate re-execution
 *                      after a classified transient failure.
 *
 * `max_attempts` is the *business* retry budget: a job may be retried while
 * `retry_count < max_attempts`. Crash recovery never consumes this budget — a
 * worker crashing is not the step's fault — so a flaky infrastructure night
 * cannot silently exhaust a step's retries.
 *
 * ## Equal-jitter backoff
 *
 * `raw = min(baseMs * factor^retryCount, maxDelayMs)` is the exponential ceiling;
 * the actual delay is `raw/2 + random()*(raw/2)`. Half the delay is fixed
 * (guarantees monotonic growth and a floor) and half is jittered (spreads a
 * thundering herd of simultaneously-failed jobs across a window instead of
 * retrying them all on the same tick). `random` is injectable so tests are
 * deterministic; in production it is `Math.random`.
 */

/** The tunable shape of the backoff curve and the retry budget. */
export interface RetryPolicyConfig {
  /** The first retry's un-jittered ceiling, in milliseconds. */
  readonly baseMs: number;
  /** The exponential base applied to `retry_count`. */
  readonly factor: number;
  /** The cap on the un-jittered ceiling — backoff never grows past this. */
  readonly maxDelayMs: number;
  /**
   * The default business retry budget. Mirrors the `jobs.max_attempts` column
   * default; the *enforced* ceiling is always the value on the job row, not this
   * constant, so a job may override it at enqueue time.
   */
  readonly maxAttempts: number;
}

/** The production defaults: 1s base, doubling, capped at 5min, 5 business retries. */
export const DEFAULT_RETRY_POLICY: RetryPolicyConfig = {
  baseMs: 1_000,
  factor: 2,
  maxDelayMs: 300_000,
  maxAttempts: 5,
};

/** Computes the delay before the next business retry. Pure, given `random`. */
export interface RetryPolicy {
  readonly config: RetryPolicyConfig;
  /**
   * The equal-jitter delay, in milliseconds, before a job with `retryCount`
   * prior business retries should next be claimable. `retryCount` is the count
   * *before* this retry (0 for the first retry).
   */
  backoffMs(retryCount: number): number;
}

/**
 * Build a retry policy. `random` returns a float in [0, 1); inject a fixed one
 * in tests to make the jittered delay deterministic. Defaults to `Math.random`.
 */
export function createRetryPolicy(
  config: RetryPolicyConfig = DEFAULT_RETRY_POLICY,
  random: () => number = Math.random,
): RetryPolicy {
  return {
    config,
    backoffMs(retryCount: number): number {
      const exponent = retryCount < 0 ? 0 : retryCount;
      const raw = Math.min(config.baseMs * config.factor ** exponent, config.maxDelayMs);
      const half = raw / 2;
      return half + random() * half;
    },
  };
}
