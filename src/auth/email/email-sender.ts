/**
 * The provider-neutral email transport seam (Phase 6 §10).
 *
 * `EmailSender` is the one interface the auth flows depend on to "send" a
 * verification or reset message. The concrete implementations are:
 *
 *   - {@link LogOnlyEmailSender} — the default (and the safe production fallback
 *     while no ESP is configured). It records that a message *would* be sent,
 *     with metadata only. It never logs the link, the token, or the body, so a
 *     normal application log can never leak a live credential (§10/§21).
 *   - `ResendEmailSender` (in `resend-email-sender.ts`) — the real ESP transport
 *     that actually delivers over HTTPS. Opt-in via `EMAIL_TRANSPORT=resend`;
 *     renders the same templates and observes the same secrets discipline.
 *   - {@link ConsoleEmailSender} — a dev-only manual-smoke transport that prints
 *     the action link to stdout (not through the structured logger). Opt-in via
 *     `EMAIL_TRANSPORT=console`, and env validation forbids it in production.
 *   - {@link RecordingEmailSender} — an in-memory test double that captures the
 *     structured inputs so a test can read the link it would have sent. Injected
 *     directly by tests, never selected by configuration.
 *
 * The interface carries STRUCTURED data (recipient, name, action URL, TTL), not
 * pre-rendered content: each transport renders via `templates.ts` itself, so
 * nothing above the seam changes when a transport is added. Secrets discipline:
 * no implementation here logs a token or a URL through the structured logger.
 */

import type { Env } from '@/config/env.js';
import type { Logger } from '@/observability/logger.js';
import {
  renderPasswordResetEmail,
  renderVerificationEmail,
  type RenderedEmail,
} from '@/auth/email/templates.js';
import { ResendEmailSender } from '@/auth/email/resend-email-sender.js';

/** A verification message to deliver. The URL was built by the notifier. */
export interface VerificationEmail {
  readonly to: string;
  readonly name: string | null;
  readonly verifyUrl: string;
  readonly expiresInMinutes: number;
}

/** A password-reset message to deliver. The URL was built by the notifier. */
export interface PasswordResetEmail {
  readonly to: string;
  readonly name: string | null;
  readonly resetUrl: string;
  readonly expiresInMinutes: number;
}

/** The seam the auth flows depend on; concrete transport is a wiring choice. */
export interface EmailSender {
  sendVerificationEmail(email: VerificationEmail): Promise<void>;
  sendPasswordResetEmail(email: PasswordResetEmail): Promise<void>;
}

/**
 * In-memory test double. Captures the structured inputs (including the URL, so a
 * test can extract the one-time token from the link it would have sent) and does
 * nothing else. Never selected by configuration — tests inject it directly.
 */
export class RecordingEmailSender implements EmailSender {
  readonly verifications: VerificationEmail[] = [];
  readonly passwordResets: PasswordResetEmail[] = [];

  async sendVerificationEmail(email: VerificationEmail): Promise<void> {
    this.verifications.push(email);
  }

  async sendPasswordResetEmail(email: PasswordResetEmail): Promise<void> {
    this.passwordResets.push(email);
  }

  /** Forget everything captured so far, so one double can serve several cases. */
  clear(): void {
    this.verifications.length = 0;
    this.passwordResets.length = 0;
  }
}

/**
 * The default transport, and the production default. It emits a single
 * structured record that a message *would* have been sent — metadata only. It
 * deliberately logs neither the action URL nor the token nor the rendered body,
 * so no application log can ever carry a live one-time credential (§10/§21).
 */
export class LogOnlyEmailSender implements EmailSender {
  constructor(private readonly logger: Logger) {}

  async sendVerificationEmail(email: VerificationEmail): Promise<void> {
    this.logger.info(
      { email_kind: 'verification', recipient: email.to },
      'auth email not delivered: no email transport configured (log-only)',
    );
  }

  async sendPasswordResetEmail(email: PasswordResetEmail): Promise<void> {
    this.logger.info(
      { email_kind: 'password_reset', recipient: email.to },
      'auth email not delivered: no email transport configured (log-only)',
    );
  }
}

/**
 * Dev-only manual-smoke transport. Renders the real template so a developer can
 * eyeball the copy, then prints the action link to stdout **directly** — not
 * through the structured logger, so it can never end up in a shipped log sink.
 * `EMAIL_TRANSPORT=console` selects it, and env validation forbids that value in
 * production, so the token only ever reaches a developer's own terminal.
 */
export class ConsoleEmailSender implements EmailSender {
  async sendVerificationEmail(email: VerificationEmail): Promise<void> {
    const rendered = renderVerificationEmail({
      name: email.name,
      verifyUrl: email.verifyUrl,
      expiresInMinutes: email.expiresInMinutes,
    });
    this.print(email.to, rendered, email.verifyUrl);
  }

  async sendPasswordResetEmail(email: PasswordResetEmail): Promise<void> {
    const rendered = renderPasswordResetEmail({
      name: email.name,
      resetUrl: email.resetUrl,
      expiresInMinutes: email.expiresInMinutes,
    });
    this.print(email.to, rendered, email.resetUrl);
  }

  private print(to: string, rendered: RenderedEmail, actionUrl: string): void {
    process.stdout.write(
      `\n─── AI Workforce dev email ───\n` +
        `To:      ${to}\n` +
        `Subject: ${rendered.subject}\n` +
        `Link:    ${actionUrl}\n` +
        `──────────────────────────────\n`,
    );
  }
}

/**
 * Select the transport from configuration. `resend` is the real ESP transport
 * (see {@link ResendEmailSender}); `console` is the opt-in dev smoke transport
 * (rejected in production by env validation); everything else — and the default —
 * is the metadata-only log transport. Each slots in as one branch here, leaving
 * every caller untouched.
 */
export function createEmailSender(env: Env, logger: Logger): EmailSender {
  switch (env.EMAIL_TRANSPORT) {
    case 'resend': {
      // Env validation (Invariant 7) guarantees both are set when the transport
      // is 'resend'; this guard is defensive and also narrows the types for the
      // constructor below.
      if (env.RESEND_API_KEY === undefined || env.EMAIL_FROM === undefined) {
        throw new Error("EMAIL_TRANSPORT='resend' requires RESEND_API_KEY and EMAIL_FROM");
      }
      return new ResendEmailSender({
        apiKey: env.RESEND_API_KEY,
        from: env.EMAIL_FROM,
        logger,
      });
    }
    case 'console':
      return new ConsoleEmailSender();
    case 'log':
    default:
      return new LogOnlyEmailSender(logger);
  }
}
