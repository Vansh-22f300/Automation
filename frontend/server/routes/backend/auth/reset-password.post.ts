import { readBody } from 'h3';
import {
  clearPasswordResetCookie,
  clearSessionCookie,
  readPasswordResetCookie,
} from '../../../utils/auth-cookie';
import { callBackendAuth, safeUpstreamError } from '../../../utils/backend-auth';
import { isTrustedOrigin } from '../../../utils/csrf';

/**
 * POST /backend/auth/reset-password — completes a password reset.
 *
 * CSRF-guarded. The one-time token is read SERVER-SIDE from the HttpOnly
 * `aw_pwreset` cookie set by the GET handoff — never from the request body, a
 * URL, or any browser-readable state (§12) — and forwarded with the new password
 * to Fastify `POST /auth/reset-password`. The browser therefore submits only
 * `{ password }`; it cannot see or choose the token.
 *
 * On success the backend has already replaced the credential and revoked EVERY
 * existing session for that user (§8/§16), so we clear both cookies: the spent
 * reset cookie and any stale `aw_session`, forcing a fresh login. No new session
 * is minted here and no sensitive backend field is forwarded.
 */
export default defineEventHandler(async (event): Promise<unknown> => {
  const config = useRuntimeConfig(event);
  const backendUrl = typeof config.backendUrl === 'string' ? config.backendUrl.trim() : '';
  if (backendUrl === '') {
    setResponseStatus(event, 503);
    return { error: { code: 'bff_unconfigured', message: 'The BFF is not configured with a backend URL.' } };
  }

  if (!isTrustedOrigin(event)) {
    setResponseStatus(event, 403);
    return { error: { code: 'forbidden_origin', message: 'Cross-origin request rejected.' } };
  }

  const token = readPasswordResetCookie(event);
  if (token === undefined || token === '') {
    // No handoff cookie ⇒ no token to spend. The same generic message the
    // backend uses for an invalid/expired token, so the two are indistinguishable.
    setResponseStatus(event, 400);
    return { error: { code: 'bad_request', message: 'This password reset link is invalid or has expired.' } };
  }

  const body = (await readBody(event).catch(() => null)) as { password?: unknown } | null;
  const password = body?.password;
  if (typeof password !== 'string' || password.length < 8) {
    // Client should enforce this too; the token cookie is left intact so a
    // corrected password can be retried against the same live token.
    setResponseStatus(event, 400);
    return { error: { code: 'bad_request', message: 'Password must be at least 8 characters.' } };
  }

  const outcome = await callBackendAuth(
    { backendUrl, bffTimeoutMs: (config as { bffTimeoutMs?: number }).bffTimeoutMs ?? 10_000 },
    { method: 'POST', path: '/auth/reset-password', jsonBody: { token, password } },
  );

  if ('networkError' in outcome) {
    // Transient: keep the reset cookie so the user can retry with the same token.
    setResponseStatus(event, outcome.networkError === 'timeout' ? 504 : 502);
    return {
      error: {
        code: outcome.networkError === 'timeout' ? 'upstream_timeout' : 'upstream_unreachable',
        message: 'The backend could not be reached.',
      },
    };
  }

  if (outcome.status === 200) {
    // The token is spent and every session for the user is revoked. Drop the
    // reset cookie and any lingering session cookie so the browser is clean and
    // the user must sign in afresh.
    clearPasswordResetCookie(event);
    clearSessionCookie(event);
    setResponseStatus(event, 200);
    return { message: 'Your password has been reset. Please sign in with your new password.' };
  }

  // A 4xx is terminal (invalid/expired/spent token): consume the dead cookie so
  // a stale token cannot linger. 5xx is handled above as transient.
  if (outcome.status >= 400 && outcome.status < 500) {
    clearPasswordResetCookie(event);
  }
  setResponseStatus(event, outcome.status);
  return safeUpstreamError(outcome.json);
});
