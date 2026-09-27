/**
 * Transactional email content for the auth flows — pure rendering, no I/O.
 *
 * Each function turns structured, already-safe input (a display name, a link the
 * caller built from the configured app origin, an expiry) into a `{subject, text,
 * html}` triple. It is deliberately provider-neutral: an `EmailSender` decides
 * how (or whether) to deliver it. Keeping this pure means the exact copy — and
 * the invariants below — are unit-testable with no transport.
 *
 * Invariants these templates hold (Phase 6 §11):
 *   - AI Workforce branding and a professional, transactional tone.
 *   - The action link and its finite expiry are stated plainly.
 *   - No password, password hash, session token, or token hash ever appears. The
 *     only secret present is the one-time link token itself — that is the whole
 *     mechanism, and it is placed only in the link, never described in prose.
 *   - The display name is HTML-escaped in the `html` part; the URL is escaped in
 *     attribute context. Neither can break out of its context.
 */

const BRAND = 'AI Workforce';

/** A rendered message, ready for any transport to deliver. */
export interface RenderedEmail {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

/** Structured input for the verification email; the URL is built by the caller. */
export interface VerificationTemplateInput {
  readonly name: string | null;
  readonly verifyUrl: string;
  readonly expiresInMinutes: number;
}

/** Structured input for the password-reset email; the URL is built by the caller. */
export interface PasswordResetTemplateInput {
  readonly name: string | null;
  readonly resetUrl: string;
  readonly expiresInMinutes: number;
}

/** Escape the five characters that matter for HTML text/attribute contexts. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Render a minute count as a friendly "24 hours" / "1 hour" / "30 minutes". */
function formatExpiry(minutes: number): string {
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return hours === 1 ? '1 hour' : `${hours} hours`;
  }
  return minutes === 1 ? '1 minute' : `${minutes} minutes`;
}

/** A polite greeting that degrades gracefully when we have no name on file. */
function greeting(name: string | null): string {
  const trimmed = name?.trim();
  return trimmed !== undefined && trimmed !== '' ? `Hi ${trimmed},` : 'Hi,';
}

export function renderVerificationEmail(input: VerificationTemplateInput): RenderedEmail {
  const expiry = formatExpiry(input.expiresInMinutes);
  const subject = `Verify your ${BRAND} email address`;

  const text = [
    greeting(input.name),
    '',
    `Thanks for creating your ${BRAND} account. Confirm this email address to finish setting up your workspace:`,
    '',
    input.verifyUrl,
    '',
    `This link expires in ${expiry}. If you didn't create a ${BRAND} account, you can safely ignore this email.`,
    '',
    `— The ${BRAND} team`,
  ].join('\n');

  const html = [
    `<p>${escapeHtml(greeting(input.name))}</p>`,
    `<p>Thanks for creating your ${BRAND} account. Confirm this email address to finish setting up your workspace:</p>`,
    `<p><a href="${escapeHtml(input.verifyUrl)}">Verify my email address</a></p>`,
    `<p>This link expires in ${expiry}. If you didn't create a ${BRAND} account, you can safely ignore this email.</p>`,
    `<p>— The ${BRAND} team</p>`,
  ].join('\n');

  return { subject, text, html };
}

export function renderPasswordResetEmail(input: PasswordResetTemplateInput): RenderedEmail {
  const expiry = formatExpiry(input.expiresInMinutes);
  const subject = `Reset your ${BRAND} password`;

  const text = [
    greeting(input.name),
    '',
    `We received a request to reset the password for your ${BRAND} account. Choose a new password here:`,
    '',
    input.resetUrl,
    '',
    `This link expires in ${expiry} and can be used once. If you didn't request a password reset, you can safely ignore this email — your password will not change.`,
    '',
    `— The ${BRAND} team`,
  ].join('\n');

  const html = [
    `<p>${escapeHtml(greeting(input.name))}</p>`,
    `<p>We received a request to reset the password for your ${BRAND} account. Choose a new password here:</p>`,
    `<p><a href="${escapeHtml(input.resetUrl)}">Reset my password</a></p>`,
    `<p>This link expires in ${expiry} and can be used once. If you didn't request a password reset, you can safely ignore this email — your password will not change.</p>`,
    `<p>— The ${BRAND} team</p>`,
  ].join('\n');

  return { subject, text, html };
}
