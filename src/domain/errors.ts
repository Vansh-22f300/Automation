/**
 * Error taxonomy.
 *
 * The whole retry system rests on one question: "should this be tried again?"
 * Answering it consistently at the point where an error is raised — rather than
 * guessing later from a message string — is the difference between failures that
 * self-heal and failures that silently burn money.
 *
 * - `RetryableError`  — transient. Timeouts, 429s, 5xx, connection resets.
 * - `PermanentError`  — deterministic. 4xx (except 429), schema violations,
 *                       missing credentials, malformed definitions.
 *
 * Connectors and LLM providers are responsible for mapping vendor-specific
 * failures onto these two types.
 */

/** Structured, log-safe diagnostic context. Must never contain secrets. */
export type ErrorDetails = Record<string, unknown>;

export interface AppErrorOptions {
  /** The underlying error, preserved for stack-trace chaining. */
  readonly cause?: unknown;
  /** Redacted diagnostic context, persisted alongside the failed step run. */
  readonly details?: ErrorDetails;
}

/**
 * Base class for all errors this system raises deliberately.
 *
 * `code` is a stable, machine-readable identifier (e.g. `llm_timeout`,
 * `invalid_definition`) suitable for persisting and for metrics. `message` is
 * for humans and may change freely.
 */
export abstract class AppError extends Error {
  /** Whether re-executing the failed operation could plausibly succeed. */
  abstract readonly retryable: boolean;

  readonly code: string;
  readonly details: ErrorDetails | undefined;

  constructor(code: string, message: string, options?: AppErrorOptions) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.code = code;
    this.details = options?.details;
    Error.captureStackTrace(this, new.target);
  }
}

/** A transient failure. Safe to retry with backoff. */
export class RetryableError extends AppError {
  override readonly retryable: true = true;
}

/** A deterministic failure. Retrying cannot help; fail fast and surface it. */
export class PermanentError extends AppError {
  override readonly retryable: false = false;
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

/**
 * Whether an unknown thrown value should be retried.
 *
 * Unclassified errors default to NOT retryable. An unrecognised error means we
 * do not understand the failure, and repeating an operation we do not
 * understand is the more dangerous of the two options — especially once steps
 * have real side effects.
 */
export function isRetryable(error: unknown): boolean {
  return isAppError(error) && error.retryable;
}
