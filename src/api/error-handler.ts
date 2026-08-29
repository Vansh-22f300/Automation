/**
 * Consistent error and not-found handling for the whole API.
 *
 * Two guarantees:
 *
 * 1. **One error envelope, always** — `{ error: { code, message, requestId } }`,
 *    whether the failure was an expected `ApiError`, a Fastify validation error,
 *    a rate-limit rejection, or something entirely unforeseen. A client can parse
 *    one shape.
 * 2. **Internal detail never crosses the boundary.** An `ApiError` is safe by
 *    construction and passes through. Anything else is logged in full server-side
 *    and returned as a generic 500 — no message, no stack, no leaked internals.
 *
 * Every response carries the `requestId` (Fastify's per-request id), which is
 * also on every log line for that request, so a user can quote it and an operator
 * can find the corresponding logs.
 */

import type { FastifyError } from 'fastify';

import { ApiError, isApiError } from '@/api/errors.js';
import type { ApiServer } from '@/api/types.js';

export function registerErrorHandling(app: ApiServer): void {
  app.setNotFoundHandler((request, reply) => {
    void reply.code(404).send({
      error: { code: 'not_found', message: 'Resource not found', requestId: request.id },
    });
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const requestId = request.id;

    if (isApiError(error)) {
      // Expected, client-safe. Log at info — these are normal (a bad key, a
      // missing resource), not incidents.
      request.log.info({ code: error.code, statusCode: error.statusCode }, 'request rejected');
      void reply.code(error.statusCode).send(error.toResponse(requestId));
      return;
    }

    // Fastify's built-in validation failures arrive with `.validation` set.
    if ('validation' in error && error.validation) {
      void reply.code(400).send({
        error: { code: 'bad_request', message: 'Request validation failed', requestId },
      });
      return;
    }

    // Rate-limit plugin (and any other Fastify error) carries a statusCode. Honour
    // 4xx as client-safe-ish but with a generic message; everything else is a 500.
    const statusCode = typeof error.statusCode === 'number' ? error.statusCode : 500;

    if (statusCode === 429) {
      void reply.code(429).send({
        error: { code: 'rate_limited', message: 'Too many requests', requestId },
      });
      return;
    }

    if (statusCode >= 400 && statusCode < 500) {
      void reply.code(statusCode).send({
        error: { code: 'bad_request', message: 'Request could not be processed', requestId },
      });
      return;
    }

    // Genuinely unexpected. The full error (and stack) goes to the log only.
    request.log.error({ err: error }, 'unhandled error');
    void reply.code(500).send({
      error: { code: 'internal_error', message: 'An unexpected error occurred', requestId },
    });
  });
}

// Re-exported for convenience so callers can `throw` without importing two modules.
export { ApiError };
