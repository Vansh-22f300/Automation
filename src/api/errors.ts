/**
 * HTTP error taxonomy for the API boundary.
 *
 * This is deliberately separate from `@/domain/errors` (RetryableError /
 * PermanentError). That taxonomy answers "should the engine retry this?"; this
 * one answers "what HTTP status and client-safe message does this become?". A
 * domain error should never be serialised straight to a client — it may carry
 * internal detail — so the boundary translates into these types instead.
 *
 * Every `ApiError` is safe to show a client: `code` is a stable machine-readable
 * string and `message` is written for external eyes. Anything that is *not* an
 * `ApiError` reaching the error handler is treated as an unexpected 500 and its
 * detail is logged but never returned.
 */

/** Shape of every error body the API emits. One envelope, always. */
export interface ErrorResponseBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    /** Correlates the response with server logs. */
    readonly requestId: string;
  };
}

/** Base class for failures that are safe to surface to a client verbatim. */
export abstract class ApiError extends Error {
  /** HTTP status this maps to. */
  abstract readonly statusCode: number;
  /** Stable, machine-readable identifier, e.g. `unauthorized`. */
  abstract readonly code: string;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
  }

  /** Render the client-safe envelope, stamped with the request id. */
  toResponse(requestId: string): ErrorResponseBody {
    return { error: { code: this.code, message: this.message, requestId } };
  }
}

/** 400 — the request itself is malformed (bad body, missing field). */
export class BadRequestError extends ApiError {
  override readonly statusCode = 400;
  override readonly code = 'bad_request';
}

/**
 * 401 — no valid credential was presented. Every distinct authentication
 * failure (missing header, malformed key, unknown key, revoked key, wrong
 * secret) collapses to this single status with an intentionally vague message:
 * telling a caller *which* of those it was only helps an attacker.
 */
export class UnauthorizedError extends ApiError {
  override readonly statusCode = 401;
  override readonly code = 'unauthorized';

  constructor(message = 'Missing or invalid API key', options?: { cause?: unknown }) {
    super(message, options);
  }
}

/** 403 — authenticated, but not allowed to do this. */
export class ForbiddenError extends ApiError {
  override readonly statusCode = 403;
  override readonly code = 'forbidden';

  constructor(message = 'You do not have access to this resource', options?: { cause?: unknown }) {
    super(message, options);
  }
}

/**
 * 404 — the resource does not exist *for this caller*. Tenant-scoped lookups
 * that miss also raise this: a tenant must not be able to tell "does not exist"
 * apart from "exists but belongs to someone else".
 */
export class NotFoundError extends ApiError {
  override readonly statusCode = 404;
  override readonly code = 'not_found';

  constructor(message = 'Resource not found', options?: { cause?: unknown }) {
    super(message, options);
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}
