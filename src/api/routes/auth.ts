/**
 * Human authentication endpoints — the browser/session counterpart to the
 * API-key surface, kept deliberately separate from `/v1/*`.
 *
 *   POST /auth/login     { email, password }  → 200 { user, tenant, session } | 401 | 409 | 429
 *   POST /auth/logout                          → 204   (revokes the current session)
 *   GET  /auth/session                         → 200 { user, tenant } | 401
 *
 * Why the split from `/v1/*`:
 *   - `POST /auth/login` is **public** — you cannot present a session before you
 *     have one — so it is registered at the top level, subject to the global
 *     per-IP limiter *and* the account-scoped login throttle inside `AuthService`.
 *   - `logout` and `session` live in their own encapsulated scope guarded by the
 *     **session** authenticator (opaque session tokens), never the API-key hook.
 *     An API key cannot satisfy these routes and a session token cannot satisfy
 *     `/v1/*`: the two credential kinds stay on structurally separate paths, and
 *     neither authenticator is loosened to accept the other's credential.
 *
 * Handlers hold no security logic; they validate the body, call `AuthService`,
 * and map its closed result set onto the shared HTTP error envelope. The session
 * token is echoed exactly once, in the login response; it is never logged, and no
 * password, hash, or token hash ever appears in any response.
 */

import { z } from 'zod';

import { readBearerToken, registerSessionAuth, requireHumanSession } from '@/api/auth-hook.js';
import {
  BadRequestError,
  RateLimitedError,
  TenantSelectionRequiredError,
  UnauthorizedError,
} from '@/api/errors.js';
import type { ApiServer } from '@/api/types.js';
import type { AuthService } from '@/auth/auth-service.js';
import type { Authenticator } from '@/auth/context.js';

export interface AuthRouteDependencies {
  /** The login/logout/current-session use-cases. */
  readonly authService: AuthService;
  /** Guards the authenticated `/auth/*` routes by resolving session tokens. */
  readonly sessionAuthenticator: Authenticator;
}

/** Permissive email shape: reject the obviously malformed without over-policing. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const loginBody = z.object({
  email: z
    .string()
    .trim()
    .min(1, 'email is required')
    .max(320, 'email is too long')
    .regex(EMAIL_RE, 'a valid email is required'),
  // Any non-empty string; login enforces no password policy (that is
  // registration's job). Capped only to bound the KDF's input size.
  password: z.string().min(1, 'password is required').max(1024, 'password is too long'),
});

export async function registerAuthRoutes(app: ApiServer, deps: AuthRouteDependencies): Promise<void> {
  // --- Public: login -------------------------------------------------------
  app.post('/auth/login', async (request, reply) => {
    const parsed = loginBody.safeParse(request.body);
    if (!parsed.success) {
      throw new BadRequestError(parsed.error.issues[0]?.message ?? 'Invalid request body');
    }

    const result = await deps.authService.login(parsed.data.email, parsed.data.password);

    switch (result.kind) {
      case 'authenticated':
        // The one and only time the plaintext session token is returned.
        return reply.code(200).send({
          user: result.user,
          tenant: result.tenant,
          session: { token: result.token, expiresAt: result.expiresAt.toISOString() },
        });
      case 'tenant_selection_required':
        throw new TenantSelectionRequiredError();
      case 'rate_limited':
        throw new RateLimitedError('Too many login attempts. Please try again later.');
      case 'invalid_credentials':
        // One generic message for every credential failure — reveals nothing
        // about whether the email exists or the password was the wrong part.
        throw new UnauthorizedError('Invalid email or password');
    }
  });

  // --- Authenticated: logout + current session -----------------------------
  // Encapsulated so the session auth hook applies only here, not to /auth/login
  // or the public health routes registered as siblings.
  await app.register(async (rawScope) => {
    const scope = rawScope as unknown as ApiServer;
    registerSessionAuth(scope, deps.sessionAuthenticator);

    scope.post('/auth/logout', async (request, reply) => {
      // The hook has already authenticated a live session; this also rejects any
      // non-human credential that somehow reached here (defence in depth).
      requireHumanSession(request);
      // Revoke exactly the token presented — never an id from body or URL — so a
      // caller can only end its own session. Idempotent, so a repeat is safe.
      await deps.authService.logout(readBearerToken(request));
      return reply.code(204).send();
    });

    scope.get('/auth/session', async (request, reply) => {
      const { userId, tenantId } = requireHumanSession(request);
      const profile = await deps.authService.getCurrentSession(userId, tenantId);
      if (profile === null) {
        // Identity vanished under a live session: fail closed with the same
        // generic 401, never a distinct "your session expired" signal.
        throw new UnauthorizedError();
      }
      return reply.code(200).send({ user: profile.user, tenant: profile.tenant });
    });
  });
}
