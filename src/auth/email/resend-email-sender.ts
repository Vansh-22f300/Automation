/**
 * The Resend email transport (Phase 6 §10, real-delivery follow-up).
 *
 * This is the first concrete {@link EmailSender} that actually sends mail. It
 * renders the shared templates itself (exactly as `ConsoleEmailSender` does — the
 * seam carries structured data, not pre-rendered content) and POSTs a single
 * message to Resend's one email endpoint over HTTPS.
 *
 * Secrets discipline (§10/§21), enforced here:
 *   - the API key travels only in the Authorization header — never logged, never
 *     placed in an error;
 *   - the rendered subject/text/html and the one-time link (and thus the token)
 *     are never logged;
 *   - a provider error never carries the provider's response body into our logs
 *     or into the thrown error — only the email kind and HTTP status escape.
 *
 * Delivery is best-effort: this sender THROWS on any failure and lets
 * {@link AuthEmailNotifier} swallow it, so a provider outage can never roll back
 * or fail signup/reset. A network/timeout failure propagates as-is; a non-2xx
 * HTTP status becomes a {@link ResendDeliveryError}. That error is deliberately a
 * plain local error — NOT an AppError/RetryableError/PermanentError — because a
 * provider transport failure is not part of the workflow-execution taxonomy.
 */

import type { Logger } from '@/observability/logger.js';
import type {
  EmailSender,
  PasswordResetEmail,
  VerificationEmail,
} from '@/auth/email/email-sender.js';
import {
  renderPasswordResetEmail,
  renderVerificationEmail,
  type RenderedEmail,
} from '@/auth/email/templates.js';

/** Resend's single "send an email" endpoint. HTTPS is fixed; never user-supplied. */
const RESEND_ENDPOINT = 'https://api.resend.com/emails';

/** Guard a hung provider call so a best-effort send cannot stall a request. */
export const DEFAULT_RESEND_TIMEOUT_MS = 10_000;

/** The `fetch` surface we use, so a test can inject a stub without DOM types. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/**
 * A provider send that returned a non-2xx status. Carries ONLY safe metadata —
 * the email kind and the HTTP status. It never includes the recipient, the link,
 * the token, or the provider's response body.
 */
export class ResendDeliveryError extends Error {
  readonly emailKind: string;
  readonly status: number;

  constructor(emailKind: string, status: number) {
    super(`resend send failed for ${emailKind} email (http ${status})`);
    this.name = 'ResendDeliveryError';
    this.emailKind = emailKind;
    this.status = status;
  }
}

export interface ResendEmailSenderOptions {
  /** Resend API key. Secret: only ever sent in the Authorization header. */
  readonly apiKey: string;
  /** Verified sender address, e.g. `AI Workforce <noreply@mail.example.com>`. */
  readonly from: string;
  readonly logger: Logger;
  /** Injectable fetch (defaults to the global) — the seam tests stub. */
  readonly fetch?: FetchLike;
  /** Per-request timeout in ms (defaults to 10s). */
  readonly timeoutMs?: number;
}

/**
 * The real ESP transport, selected by `EMAIL_TRANSPORT=resend`. One class, one
 * endpoint, one method — it cannot be pointed at an arbitrary URL.
 */
export class ResendEmailSender implements EmailSender {
  private readonly apiKey: string;
  private readonly from: string;
  private readonly logger: Logger;
  private readonly fetchFn: FetchLike;
  private readonly timeoutMs: number;

  constructor(options: ResendEmailSenderOptions) {
    this.apiKey = options.apiKey;
    this.from = options.from;
    this.logger = options.logger;
    this.fetchFn = options.fetch ?? (globalThis.fetch as FetchLike);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_RESEND_TIMEOUT_MS;
  }

  async sendVerificationEmail(email: VerificationEmail): Promise<void> {
    const rendered = renderVerificationEmail({
      name: email.name,
      verifyUrl: email.verifyUrl,
      expiresInMinutes: email.expiresInMinutes,
    });
    await this.deliver('verification', email.to, rendered);
  }

  async sendPasswordResetEmail(email: PasswordResetEmail): Promise<void> {
    const rendered = renderPasswordResetEmail({
      name: email.name,
      resetUrl: email.resetUrl,
      expiresInMinutes: email.expiresInMinutes,
    });
    await this.deliver('password_reset', email.to, rendered);
  }

  /**
   * POST one rendered message to Resend. Resolves on 2xx; throws
   * {@link ResendDeliveryError} on a non-2xx status; lets a network/timeout
   * failure propagate. Nothing sensitive is logged or thrown on any path.
   */
  private async deliver(kind: string, to: string, rendered: RenderedEmail): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchFn(RESEND_ENDPOINT, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          from: this.from,
          to: [to],
          subject: rendered.subject,
          html: rendered.html,
          text: rendered.text,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        // Drain and DISCARD the body: it may echo details we must never log.
        await response.text().catch(() => undefined);
        throw new ResendDeliveryError(kind, response.status);
      }

      // Success: log metadata only — never recipient, link, token, or body.
      this.logger.info({ email_kind: kind }, 'auth email dispatched via resend');
    } finally {
      clearTimeout(timer);
    }
  }
}
