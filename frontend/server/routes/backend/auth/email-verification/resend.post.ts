import { readSessionCookie } from '../../../../utils/auth-cookie';
import { callBackendAuth, safeUpstreamError } from '../../../../utils/backend-auth';
import { isTrustedOrigin } from '../../../../utils/csrf';

/**
 * POST /backend/auth/email-verification/resend — re-send the verification email
 * to the CURRENTLY authenticated user.
 *
 * CSRF-guarded. Identity comes solely from the HttpOnly `aw_session` cookie,
 * forwarded as a Bearer token to Fastify `POST /auth/email-verification/resend`;
 * the browser cannot supply a different user id or email (§5). No session cookie
 * ⇒ 401. The backend rate-limits and treats both `sent` and `already_verified`
 * as benign 200s about the caller's own account, so nothing about anyone else
 * leaks. No sensitive backend field is forwarded to the browser.
 */
export default defineEventHandler(async (event): Promise<unknown> => {
  if (!isTrustedOrigin(event)) {
    setResponseStatus(event, 403);
    return { error: { code: 'forbidden_origin', message: 'Cross-origin request rejected.' } };
  }

  const token = readSessionCookie(event);
  if (token === undefined) {
    setResponseStatus(event, 401);
    return { error: { code: 'unauthorized', message: 'Not authenticated.' } };
  }

  const config = useRuntimeConfig(event);
  const backendUrl = typeof config.backendUrl === 'string' ? config.backendUrl.trim() : '';
  if (backendUrl === '') {
    setResponseStatus(event, 503);
    return { error: { code: 'bff_unconfigured', message: 'The BFF is not configured with a backend URL.' } };
  }

  const outcome = await callBackendAuth(
    { backendUrl, bffTimeoutMs: (config as { bffTimeoutMs?: number }).bffTimeoutMs ?? 10_000 },
    { method: 'POST', path: '/auth/email-verification/resend', token },
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

  if (outcome.status === 200) {
    const data = outcome.json as { message?: unknown } | null;
    setResponseStatus(event, 200);
    return {
      message:
        typeof data?.message === 'string' ? data.message : 'Verification email sent.',
    };
  }

  setResponseStatus(event, outcome.status);
  return safeUpstreamError(outcome.json);
});
