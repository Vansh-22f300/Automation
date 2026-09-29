/**
 * Return-path validation — the defence for requirement §7 of the OAuth state
 * design: the path the browser wants to land on after the flow is *untrusted
 * input* and must never become an open redirect.
 *
 * An OAuth callback ends in a server-issued redirect. If the destination were
 * taken verbatim from caller-supplied data, an attacker could craft an authorize
 * request whose `returnPath` is `https://evil.example/phish` (or the
 * protocol-relative `//evil.example`) and turn our trusted callback into a
 * redirector to their site. So we accept only *safe internal relative paths*:
 *
 *   - must begin with a single `/` (a site-relative path);
 *   - must NOT begin with `//` or `/\`, which browsers treat as protocol-relative
 *     (i.e. off-site) URLs;
 *   - must NOT contain whitespace, control characters, or a backslash;
 *   - is length-bounded.
 *
 * A value that is absent falls back to {@link DEFAULT_RETURN_PATH}; a value that
 * is present but unsafe is rejected outright (a `BadRequestError` at authorize
 * time) rather than silently coerced — a caller sending a bad path is a bug or an
 * attack, and swallowing it would hide both.
 */

import { BadRequestError } from '@/api/errors.js';

/** Where a flow returns when the caller named no path of its own. */
export const DEFAULT_RETURN_PATH = '/connections';

/** Hard ceiling; real return paths are short, and this bounds what we persist. */
const MAX_RETURN_PATH_LENGTH = 512;

/**
 * Whether a string is a safe internal relative path we are willing to redirect a
 * browser to. Pure predicate — no throwing — so tests and callers can probe it.
 */
export function isSafeInternalPath(value: string): boolean {
  if (value.length === 0 || value.length > MAX_RETURN_PATH_LENGTH) return false;
  // Site-relative only. A leading `//` or `/\` is a protocol-relative (off-site)
  // URL in browsers, so those are rejected despite the leading slash.
  if (!value.startsWith('/')) return false;
  if (value.startsWith('//') || value.startsWith('/\\')) return false;
  // No whitespace, controls, or backslashes anywhere: these enable header/redirect
  // smuggling and browser-specific normalisation surprises.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\s\\]/.test(value)) return false;
  return true;
}

/**
 * Resolve the caller's requested return path into a value safe to persist and
 * later redirect to. Absent → the default. Present-and-safe → itself.
 * Present-and-unsafe → {@link BadRequestError} (never coerced to the default,
 * so an open-redirect attempt is refused loudly, not masked).
 */
export function resolveReturnPath(requested: string | undefined): string {
  if (requested === undefined) return DEFAULT_RETURN_PATH;
  if (!isSafeInternalPath(requested)) {
    throw new BadRequestError('returnPath must be a safe internal path beginning with "/"');
  }
  return requested;
}
