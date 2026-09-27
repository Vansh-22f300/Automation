/**
 * The policy layer between the auth flows and the raw {@link EmailSender} seam
 * (Phase 6 §10/§11/§12). It owns three things the transport must never decide:
 *
 *   1. **Link lifetimes.** {@link VERIFICATION_TTL_MS} / {@link PASSWORD_RESET_TTL_MS}
 *      are the single source of truth for how long a link lives — the same value
 *      is used to stamp the token row's `expires_at` and to word the email copy.
 *   2. **Link construction from a trusted origin.** URLs are built from the
 *      server-configured `APP_ORIGIN`, never from a browser-supplied Host/Origin
 *      header (§11), so a link can never be pointed at an attacker's domain.
 *   3. **Best-effort delivery.** A transport failure must not fail (or change the
 *      shape of) the caller's flow — signup still succeeds, forgot-password still
 *      returns its generic 202. Failures are swallowed and logged metadata-only.
 *
 * The one-time token is carried only inside the URL; it is never logged here, not
 * even on the failure path (we log the error's type, never its message or URL).
 *
 * The links target same-origin BFF GET handoff routes rather than pages: the
 * server consumes/pins the token and redirects to a clean URL, so the raw token
 * never lands in client history or state (§12).
 */

import type { Logger } from '@/observability/logger.js';
import type {
  EmailSender,
  PasswordResetEmail,
  VerificationEmail,
} from '@/auth/email/email-sender.js';

/** Verification links live for 24 hours. */
export const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;
/** Password-reset links live for 1 hour — shorter, since they change a credential. */
export const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;

/** Join an origin and an absolute path without doubling a slash. */
function joinOrigin(appOrigin: string, path: string): string {
  const base = appOrigin.endsWith('/') ? appOrigin.slice(0, -1) : appOrigin;
  return `${base}${path}`;
}

/** The email link for confirming an address — a same-origin BFF GET handoff. */
export function buildVerificationUrl(appOrigin: string, rawToken: string): string {
  return joinOrigin(appOrigin, `/backend/auth/verify-email?token=${encodeURIComponent(rawToken)}`);
}

/** The email link for choosing a new password — a same-origin BFF GET handoff. */
export function buildPasswordResetUrl(appOrigin: string, rawToken: string): string {
  return joinOrigin(appOrigin, `/backend/auth/reset-password?token=${encodeURIComponent(rawToken)}`);
}

/** What the caller knows when a verification link should go out. */
export interface SendVerificationInput {
  readonly to: string;
  readonly name: string | null;
  /** The plaintext token — placed only in the link, never stored or logged. */
  readonly rawToken: string;
}

/** What the caller knows when a password-reset link should go out. */
export interface SendPasswordResetInput {
  readonly to: string;
  readonly name: string | null;
  /** The plaintext token — placed only in the link, never stored or logged. */
  readonly rawToken: string;
}

/**
 * The notifier seam the auth + recovery services depend on. `AuthService` needs
 * only {@link AuthNotifier.sendVerification}; the recovery service needs both.
 */
export interface AuthNotifier {
  sendVerification(input: SendVerificationInput): Promise<void>;
  sendPasswordReset(input: SendPasswordResetInput): Promise<void>;
}

/** The error's type only — never its message, which could echo a URL/token. */
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/**
 * Turns a raw token + recipient into a fully-built, expiry-worded message and
 * hands it to the transport. Delivery is best-effort: any transport error is
 * swallowed and logged metadata-only, so the surrounding flow is never coupled
 * to whether mail actually left.
 */
export class AuthEmailNotifier implements AuthNotifier {
  constructor(
    private readonly emailSender: EmailSender,
    private readonly appOrigin: string,
    private readonly logger: Logger,
  ) {}

  async sendVerification(input: SendVerificationInput): Promise<void> {
    const email: VerificationEmail = {
      to: input.to,
      name: input.name,
      verifyUrl: buildVerificationUrl(this.appOrigin, input.rawToken),
      expiresInMinutes: VERIFICATION_TTL_MS / 60_000,
    };
    try {
      await this.emailSender.sendVerificationEmail(email);
    } catch (error) {
      this.warnFailed('verification', input.to, error);
    }
  }

  async sendPasswordReset(input: SendPasswordResetInput): Promise<void> {
    const email: PasswordResetEmail = {
      to: input.to,
      name: input.name,
      resetUrl: buildPasswordResetUrl(this.appOrigin, input.rawToken),
      expiresInMinutes: PASSWORD_RESET_TTL_MS / 60_000,
    };
    try {
      await this.emailSender.sendPasswordResetEmail(email);
    } catch (error) {
      this.warnFailed('password_reset', input.to, error);
    }
  }

  private warnFailed(kind: string, recipient: string, error: unknown): void {
    this.logger.warn(
      { email_kind: kind, recipient, err_name: errorName(error) },
      'auth email dispatch failed; continuing (best-effort delivery)',
    );
  }
}
