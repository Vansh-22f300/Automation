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
 * Read the raw bearer token off a request, applying the same extraction rules as
 * the auth hook. Used by the logout handler, which must revoke *the very token it
 * was authenticated with* — it re-reads the presented token rather than trusting
 * any id from the body or URL, so a caller can only ever end its own session.
 */
export function readBearerToken(request: FastifyRequest): string {
  return extractCredential(request);
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

/** The context of a human-session caller: a person acting within one tenant. */
export interface HumanSessionContext {
  readonly tenantId: string;
  readonly userId: string;
}

/**
 * Narrow the request's context to a human session, or reject with a 401.
 *
 * The `/auth/*` authenticated scope is guarded by the session authenticator, so
 * in practice only session tokens reach it. This is the explicit, defence-in-depth
 * check that a human-only route can never be satisfied by a machine credential:
 * an API-key context carries `apiKeyId` and no `userId`, so it fails here even in
 * the impossible event it reached this scope. The human-only routes (logout,
 * current session) go through this rather than bare `requireAuth`.
 */
export function requireHumanSession(request: FastifyRequest): HumanSessionContext {
  const auth = requireAuth(request);
  if (auth.userId === undefined) {
    throw new UnauthorizedError();
  }
  return { tenantId: auth.tenantId, userId: auth.userId };
}

/** Register a bearer-token `onRequest` hook on an encapsulated scope. */
function registerBearerAuth(scope: ApiServer, authenticator: Authenticator): void {
  scope.addHook('onRequest', async (request) => {
    const credential = extractCredential(request);
    request.auth = await authenticator.authenticate(credential);
  });
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
  registerBearerAuth(scope, authenticator);
}

/**
 * Attach *human-session* authentication to a Fastify scope — the `/auth/logout`
 * and `/auth/session` routes.
 *
 * Deliberately a separate entry point from {@link registerApiKeyAuth}, guarded by
 * a distinct authenticator (the session authenticator, resolving opaque session
 * tokens against the `sessions` table). This keeps the two credential kinds on
 * structurally separate paths: a session token presented to the `/v1` API-key
 * scope has no key prefix and is rejected there, and an API key presented here
 * hashes to a value that is not a live session and is rejected here. Neither
 * authenticator is weakened to accept the other's credential.
 */
export function registerSessionAuth(scope: ApiServer, authenticator: Authenticator): void {
  registerBearerAuth(scope, authenticator);
}
