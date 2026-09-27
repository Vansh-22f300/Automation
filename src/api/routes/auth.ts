/**
 * Human authentication endpoints — the browser/session counterpart to the
 * API-key surface, kept deliberately separate from `/v1/*`.
 *
 *   POST /auth/login     { email, password }  → 200 { user, tenant, session } | 401 | 409 | 429
 *   POST /auth/signup    { name, email, password, workspaceName } → 201 | 409 | 429
 *   POST /auth/forgot-password { email }        → 202 (always; never an oracle)
 *   POST /auth/reset-password  { token, password } → 200 | 400
 *   POST /auth/verify-email    { token }        → 200 | 400
 *   POST /auth/logout                          → 204   (revokes the current session)
 *   POST /auth/email-verification/resend        → 200 | 429  (authenticated)
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
  EmailUnavailableError,
  RateLimitedError,
  TenantSelectionRequiredError,
  UnauthorizedError,
} from '@/api/errors.js';
import type { ApiServer } from '@/api/types.js';
import type { AuthService } from '@/auth/auth-service.js';
import type { AccountRecoveryService } from '@/auth/account-recovery-service.js';
import type { Authenticator } from '@/auth/context.js';

export interface AuthRouteDependencies {
  /** The login/logout/current-session use-cases. */
  readonly authService: AuthService;
  /** Email verification + password recovery use-cases (Phase 6). */
  readonly accountRecoveryService: AccountRecoveryService;
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

/**
 * Signup accepts only the four fields the person supplies. Unknown keys are
 * stripped by Zod's default object parsing, so a client cannot smuggle a
 * `userId`, `tenantId`, or `role` into account creation — the server derives
 * every identity fact itself. `name`/`email`/`workspaceName` are trimmed;
 * `password` is not (leading/trailing spaces can be meaningful in a secret).
 */
const signupBody = z.object({
  name: z.string().trim().min(1, 'name is required').max(200, 'name is too long'),
  email: z
    .string()
    .trim()
    .min(1, 'email is required')
    .max(320, 'email is too long')
    .regex(EMAIL_RE, 'a valid email is required'),
  // A deliberately modest, explicit policy: present and long enough to not be
  // trivially guessable, capped to bound the KDF's input. Not an enterprise
  // complexity regime — that is out of scope.
  password: z
    .string()
    .min(8, 'password must be at least 8 characters')
    .max(1024, 'password is too long'),
  workspaceName: z
    .string()
    .trim()
    .min(1, 'workspace name is required')
    .max(200, 'workspace name is too long'),
});

/** Forgot-password takes only an email; every outcome yields the same 202. */
const forgotPasswordBody = z.object({
  email: z
    .string()
    .trim()
    .min(1, 'email is required')
    .max(320, 'email is too long')
    .regex(EMAIL_RE, 'a valid email is required'),
});

/**
 * Reset takes the one-time token (forwarded server-side by the BFF, never read
 * from browser state) and the new password. The password policy is identical to
 * signup's — reusing the same minimum so a reset can never set a weaker secret.
 */
const resetPasswordBody = z.object({
  token: z.string().min(1, 'token is required').max(4096, 'token is too long'),
  password: z
    .string()
    .min(8, 'password must be at least 8 characters')
    .max(1024, 'password is too long'),
});

/** Verify-email takes only the one-time token; the token alone names the user. */
const verifyEmailBody = z.object({
  token: z.string().min(1, 'token is required').max(4096, 'token is too long'),
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

  // --- Public: signup ------------------------------------------------------
  // Creates a brand-new account and its first workspace, then returns a live
  // session exactly like login — the BFF banks the token as an HttpOnly cookie
  // and strips it from the browser response. Public, so subject to the same
  // global per-IP limiter as login; account creation is transactional in
  // `AuthService.signup`, so a failure leaves nothing behind.
  app.post('/auth/signup', async (request, reply) => {
    const parsed = signupBody.safeParse(request.body);
    if (!parsed.success) {
      throw new BadRequestError(parsed.error.issues[0]?.message ?? 'Invalid request body');
    }

    const result = await deps.authService.signup(parsed.data);

    switch (result.kind) {
      case 'created':
        // 201: a new account + workspace now exist. The plaintext session token
        // is echoed exactly once here, for the BFF to consume.
        return reply.code(201).send({
          user: result.user,
          tenant: result.tenant,
          session: { token: result.token, expiresAt: result.expiresAt.toISOString() },
        });
      case 'email_taken':
        // A single generic 409 that never varies with the account's details.
        throw new EmailUnavailableError();
    }
  });

  // --- Public: forgot password --------------------------------------------
  // Always answers with the same 202, whatever happened: the service returns void
  // and never signals whether the account exists (§6), so this endpoint is not a
  // user-enumeration oracle. The per-email throttle lives inside the service.
  app.post('/auth/forgot-password', async (request, reply) => {
    const parsed = forgotPasswordBody.safeParse(request.body);
    if (!parsed.success) {
      throw new BadRequestError(parsed.error.issues[0]?.message ?? 'Invalid request body');
    }
    await deps.accountRecoveryService.requestPasswordReset(parsed.data.email);
    // One fixed response for every path — success, unknown email, or throttled.
    return reply.code(202).send({
      message: 'If an account exists, password reset instructions will be sent.',
    });
  });

  // --- Public: reset password ---------------------------------------------
  // Completes a reset from a one-time token forwarded server-side by the BFF
  // (never exposed to browser state, §12). On success the service has already
  // replaced the credential and revoked every existing session for that user, so
  // the caller must sign in afresh — no session is minted here.
  app.post('/auth/reset-password', async (request, reply) => {
    const parsed = resetPasswordBody.safeParse(request.body);
    if (!parsed.success) {
      throw new BadRequestError(parsed.error.issues[0]?.message ?? 'Invalid request body');
    }
    const result = await deps.accountRecoveryService.resetPassword(
      parsed.data.token,
      parsed.data.password,
    );
    if (result.kind === 'invalid') {
      // One generic message for unknown / expired / already-spent tokens alike.
      throw new BadRequestError('This password reset link is invalid or has expired.');
    }
    return reply.code(200).send({
      message: 'Your password has been reset. Please sign in with your new password.',
    });
  });

  // --- Public: verify email -----------------------------------------------
  // Confirms an address from a one-time token. Public and identity-free at the
  // request layer: the token itself names the user (§3), so a signed-out click
  // still verifies. The BFF calls this server-side from its GET handoff and then
  // redirects to a clean URL, so the raw token never lands in browser history.
  app.post('/auth/verify-email', async (request, reply) => {
    const parsed = verifyEmailBody.safeParse(request.body);
    if (!parsed.success) {
      throw new BadRequestError(parsed.error.issues[0]?.message ?? 'Invalid request body');
    }
    const result = await deps.accountRecoveryService.verifyEmail(parsed.data.token);
    if (result.kind === 'invalid') {
      throw new BadRequestError('This verification link is invalid or has expired.');
    }
    return reply.code(200).send({ message: 'Your email address has been verified.' });
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

    // Re-send the verification email to the authenticated user. Identity comes
    // from the verified session — never a body-supplied id/email (§5). Rate
    // limited in the service; `already_verified` and `sent` are both benign 200s
    // about the caller's own account, so neither leaks anyone else's state.
    scope.post('/auth/email-verification/resend', async (request, reply) => {
      const { userId, tenantId } = requireHumanSession(request);
      const result = await deps.accountRecoveryService.resendVerification(userId, tenantId);
      switch (result.kind) {
        case 'sent':
          return reply.code(200).send({ message: 'Verification email sent.' });
        case 'already_verified':
          return reply.code(200).send({ message: 'Your email address is already verified.' });
        case 'rate_limited':
          throw new RateLimitedError('Too many requests. Please try again later.');
      }
    });
  });
}
