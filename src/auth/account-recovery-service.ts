/**
 * Account recovery — the framework-free use-cases for email verification and
 * password reset (Phase 6 §3/§5/§6/§7/§8). Like `@/auth/auth-service`, it knows
 * nothing of HTTP or cookies: it takes plain inputs and returns discriminated
 * results the route maps to status codes, so every security decision is
 * unit-testable against fakes with no server.
 *
 * Load-bearing invariants:
 *   - Tokens are opaque and single-use; only their SHA-256 hash is ever stored,
 *     and `consume` is the atomic gate that makes a replay match no row.
 *   - Consume + the state change it authorises share one transaction (verify:
 *     mark-verified; reset: replace credential + revoke all sessions), so a token
 *     is never spent without its effect landing, and two racers cannot both win.
 *   - Forgot-password is not an enumeration oracle: it always returns void and
 *     the route always answers one fixed 202, whatever happened here.
 *   - Identity is server-derived: verify/reset act on the user the token names;
 *     resend acts on the session's user — never a browser-supplied id/email.
 *   - Raw tokens and plaintext passwords are never logged; the KDF runs outside
 *     every transaction.
 */

import type { AppDatabase } from '@/db/client.js';
import type { AuthTokenStore } from '@/auth/auth-token-store.js';
import type { AuthUserStore } from '@/auth/auth-user-store.js';
import type { SessionStore } from '@/auth/session-store.js';
import type { PasswordCredentialStore } from '@/auth/password-credential-store.js';
import type { PasswordHasher } from '@/auth/password.js';
import type { LoginThrottle } from '@/auth/login-throttle.js';
import {
  PASSWORD_RESET_TTL_MS,
  VERIFICATION_TTL_MS,
  type AuthNotifier,
} from '@/auth/email/auth-email-notifier.js';
import { generateAuthToken, hashAuthToken } from '@/auth/auth-token.js';

/** Normalise an email the same way the auth service does: trimmed, lower-cased. */
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Outcome of confirming an email — the generic `invalid` hides every failure. */
export type VerifyEmailResult = { readonly kind: 'verified' } | { readonly kind: 'invalid' };

/** Outcome of a resend request from the authenticated user. */
export type ResendVerificationResult =
  | { readonly kind: 'sent' }
  | { readonly kind: 'already_verified' }
  | { readonly kind: 'rate_limited' };

/** Outcome of completing a reset — the generic `invalid` hides every failure. */
export type ResetPasswordResult = { readonly kind: 'reset' } | { readonly kind: 'invalid' };

/** Everything the recovery use-cases need, injected so they stay testable. */
export interface AccountRecoveryDependencies {
  readonly db: AppDatabase;
  readonly tokens: AuthTokenStore;
  readonly users: AuthUserStore;
  readonly sessions: SessionStore;
  readonly credentials: PasswordCredentialStore;
  readonly passwordHasher: PasswordHasher;
  readonly throttle: LoginThrottle;
  readonly notifier: AuthNotifier;
}

export class AccountRecoveryService {
  constructor(private readonly deps: AccountRecoveryDependencies) {}

  /**
   * Confirm an email from a verification link. Consuming the token and stamping
   * `email_verified_at` share one transaction, so the token is spent only if the
   * mark also lands. `consume` is the atomic single-use gate: a replayed, expired,
   * or forged link matches no row and collapses to the generic `invalid`,
   * revealing nothing about why. The account acted on is the one the token names —
   * never a browser-supplied id (§3).
   */
  async verifyEmail(rawToken: string): Promise<VerifyEmailResult> {
    const tokenHash = hashAuthToken(rawToken);
    return this.deps.db.transaction(async (tx) => {
      const consumed = await this.deps.tokens.consume(
        { tokenHash, purpose: 'email_verification' },
        tx,
      );
      if (consumed === null) return { kind: 'invalid' };
      await this.deps.users.markEmailVerified(consumed.userId, tx);
      return { kind: 'verified' };
    });
  }

  /**
   * Re-send a verification email to the *currently authenticated* user. The
   * (userId, tenantId) come from the verified session, never the request body
   * (§5), so a browser cannot ask us to verify someone else's address. Reuses the
   * login throttle under a namespaced key (`resend:<userId>`) rather than a second
   * rate limiter (§17). Minting a fresh token first invalidates any earlier live
   * ones, so only the newest link works.
   */
  async resendVerification(
    userId: string,
    tenantId: string,
  ): Promise<ResendVerificationResult> {
    const throttleKey = `resend:${userId}`;
    if (await this.deps.throttle.isThrottled(throttleKey)) {
      return { kind: 'rate_limited' };
    }
    await this.deps.throttle.recordFailure(throttleKey);

    const profile = await this.deps.users.findProfile(userId, tenantId);
    // Already confirmed → nothing to do. A vanished profile (membership removed
    // out from under the session) is folded into the same benign no-op, so we
    // never send to a stale identity and never signal that it disappeared.
    if (profile === null || profile.user.emailVerifiedAt !== null) {
      return { kind: 'already_verified' };
    }

    const rawToken = generateAuthToken();
    const expiresAt = new Date(Date.now() + VERIFICATION_TTL_MS);
    await this.deps.db.transaction(async (tx) => {
      await this.deps.tokens.invalidateActiveForUser(
        { userId, purpose: 'email_verification' },
        tx,
      );
      await this.deps.tokens.create(
        { userId, purpose: 'email_verification', tokenHash: hashAuthToken(rawToken), expiresAt },
        tx,
      );
    });

    await this.deps.notifier.sendVerification({
      to: profile.user.email,
      name: profile.user.name,
      rawToken,
    });
    return { kind: 'sent' };
  }

  /**
   * Begin a password reset for an email. **Always resolves to void**: the route
   * turns every path here into one fixed 202, so the endpoint cannot be probed to
   * learn whether an account, tenant, or membership exists (§6). A link is minted
   * only for a real, *active* account; unknown email, disabled user, and throttled
   * caller are all silent no-ops behind the identical response. Keyed on the
   * submitted email (`pwreset:<email>`), so a known and an unknown address are
   * throttled the same way — the throttle is not an oracle either. A fresh token
   * invalidates any earlier live ones.
   */
  async requestPasswordReset(rawEmail: string): Promise<void> {
    const email = normalizeEmail(rawEmail);
    const throttleKey = `pwreset:${email}`;
    if (await this.deps.throttle.isThrottled(throttleKey)) return;
    await this.deps.throttle.recordFailure(throttleKey);

    const account = await this.deps.users.findLoginByEmail(email);
    if (account === null || account.userStatus !== 'active') return;

    const rawToken = generateAuthToken();
    const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_MS);
    await this.deps.db.transaction(async (tx) => {
      await this.deps.tokens.invalidateActiveForUser(
        { userId: account.userId, purpose: 'password_reset' },
        tx,
      );
      await this.deps.tokens.create(
        { userId: account.userId, purpose: 'password_reset', tokenHash: hashAuthToken(rawToken), expiresAt },
        tx,
      );
    });

    await this.deps.notifier.sendPasswordReset({
      to: account.email,
      name: account.name,
      rawToken,
    });
  }

  /**
   * Complete a password reset. The new Argon2id hash is computed *before* the
   * transaction (the slow KDF must never hold a connection or row locks), then one
   * transaction consumes the token, replaces the credential, and revokes every
   * session the user holds across all tenants (§8) — all of it or none. `consume`
   * is the atomic single-use gate, so two racing resets cannot both win: the loser
   * matches no row and gets the generic `invalid`. No new session is minted — the
   * user must log in again with the new password. Hashing before the token is
   * validated means a bad token wastes one KDF; that is the accepted cost of the
   * "never hash inside a transaction" rule, and the route sits behind the global
   * rate limiter.
   */
  async resetPassword(rawToken: string, newPassword: string): Promise<ResetPasswordResult> {
    const passwordHash = await this.deps.passwordHasher.hash(newPassword);
    const tokenHash = hashAuthToken(rawToken);
    return this.deps.db.transaction(async (tx) => {
      const consumed = await this.deps.tokens.consume(
        { tokenHash, purpose: 'password_reset' },
        tx,
      );
      if (consumed === null) return { kind: 'invalid' };
      await this.deps.credentials.replace(consumed.userId, passwordHash, tx);
      await this.deps.sessions.revokeAllForUserAcrossTenants(consumed.userId, tx);
      return { kind: 'reset' };
    });
  }
}
