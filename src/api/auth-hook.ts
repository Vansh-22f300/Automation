/**
 * The HTTP → `AuthContext` adapter.
 *
 * This is the *only* file that knows both about Fastify requests and about the
 * `Authenticator` seam; it is where the transport-specific bits (reading the
 * `Authorization` header) meet the framework-free authentication contract. Routes
 * never call the authenticator directly — they read the already-resolved
 * `request.auth`, so route code stays ignorant of how identity was established.
 *
 * Registered as an `onRequest` hook so an unauthenticated request is rejected
 * before its body is even parsed. Any `UnauthorizedError` it throws flows to the
 * central error handler and becomes a 401 in the standard envelope.
 */

import type { FastifyRequest } from 'fastify';

import { UnauthorizedError } from '@/api/errors.js';
import type { ApiServer } from '@/api/types.js';
import type { AuthContext, Authenticator } from '@/auth/context.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Present once the auth hook has run on a protected route. */
    auth?: AuthContext;
  }
}

const BEARER_PREFIX = 'Bearer ';

/** Pull the credential out of `Authorization: Bearer <key>`. */
function extractCredential(request: FastifyRequest): string {
  const header = request.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith(BEARER_PREFIX)) {
    throw new UnauthorizedError();
  }
  const credential = header.slice(BEARER_PREFIX.length).trim();
  if (credential === '') {
    throw new UnauthorizedError();
  }
  return credential;
}

/**
 * Read the authenticated context off a request, or fail loudly.
 *
 * Routes registered inside the authenticated scope can rely on `request.auth`
 * being set; this helper turns the "impossible" absence into a clear 401 instead
 * of an undefined-access crash, and narrows the type for callers.
 */
export function requireAuth(request: FastifyRequest): AuthContext {
  if (request.auth === undefined) {
    throw new UnauthorizedError();
  }
  return request.auth;
}

/**
 * Attach API-key authentication to a Fastify scope.
 *
 * Call this on an *encapsulated* child instance (one created via `app.register`)
 * so the `onRequest` hook applies only to routes in that scope. Public routes
 * such as `/healthz`, registered in a sibling scope, are deliberately left
 * unauthenticated. (This is why it is a plain hook registration and not a
 * `fastify-plugin`: hoisting the hook to the parent would protect everything,
 * including health.)
 */
export function registerApiKeyAuth(scope: ApiServer, authenticator: Authenticator): void {
  scope.addHook('onRequest', async (request) => {
    const credential = extractCredential(request);
    request.auth = await authenticator.authenticate(credential);
  });
}
