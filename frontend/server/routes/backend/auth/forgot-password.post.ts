import { readBody } from 'h3';
import { callBackendAuth } from '../../../utils/backend-auth';
import { isTrustedOrigin } from '../../../utils/csrf';

/**
 * POST /backend/auth/forgot-password — public password-reset request boundary.
 *
 * CSRF-guarded by Origin/Referer. Forwards { email } to Fastify
 * `POST /auth/forgot-password` server-side with NO credential attached (the
 * endpoint is public). The backend NEVER reveals whether the account exists —
 * it always answers 202 — so this route mirrors that exactly: whenever the
 * backend accepts the request it returns the one fixed generic message, and it
 * never forwards any backend body field through to the browser. The route is
 * therefore not a user-enumeration oracle: success, unknown email, and a
 * throttled request are indistinguishable to the caller.
 */
const GENERIC_MESSAGE = 'If an account exists, password reset instructions will be sent.';

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

  const body = (await readBody(event).catch(() => null)) as { email?: unknown } | null;
  const email = body?.email;
  if (typeof email !== 'string' || email.trim() === '') {
    setResponseStatus(event, 400);
    return { error: { code: 'bad_request', message: 'An email address is required.' } };
  }

  const outcome = await callBackendAuth(
    { backendUrl, bffTimeoutMs: (config as { bffTimeoutMs?: number }).bffTimeoutMs ?? 10_000 },
    { method: 'POST', path: '/auth/forgot-password', jsonBody: { email } },
  );

  if ('networkError' in outcome) {
    setResponseStatus(event, outcome.networkError === 'timeout' ? 504 : 502);
    return {
      error: {
        code: outcome.networkError === 'timeout' ? 'upstream_timeout' : 'upstream_unreachable',
        message: 'The backend could not be reached.',
      },
    };
  }

  // The backend answers 202 for every account state. Return the same fixed
  // envelope regardless of the upstream body, so nothing about the account can
  // be inferred from this response.
  if (outcome.status === 202) {
    setResponseStatus(event, 202);
    return { message: GENERIC_MESSAGE };
  }

  // A malformed email is an input error (independent of account existence), so a
  // 400 here leaks nothing. Any other status collapses to the generic 202 so the
  // route can never become an oracle through an unexpected upstream code.
  if (outcome.status === 400) {
    setResponseStatus(event, 400);
    return { error: { code: 'bad_request', message: 'An email address is required.' } };
  }

  setResponseStatus(event, 202);
  return { message: GENERIC_MESSAGE };
});
