import { getQuery, sendRedirect } from 'h3';
import { callBackendAuth } from '../../../utils/backend-auth';

/**
 * GET /backend/auth/verify-email?token=… — the email-link handoff.
 *
 * The verification email points here (a top-level browser navigation, so GET and
 * CSRF-exempt). The one-time token is consumed SERVER-SIDE — forwarded to
 * Fastify `POST /auth/verify-email` — and then this handler 302-redirects to the
 * clean SPA page `/verify-email?status=…`. The raw token is never placed in the
 * destination URL, browser history, or any browser-readable state (§12); only a
 * coarse status flag survives:
 *
 *   - success → the address is now verified
 *   - invalid → unknown / expired / already-spent token, or none supplied
 *   - error   → the backend was unreachable (transient; the link can be retried)
 *
 * The token itself names the user (§3), so a signed-out click still verifies.
 */
export default defineEventHandler(async (event): Promise<void> => {
  const token = getQuery(event).token;
  if (typeof token !== 'string' || token === '') {
    return sendRedirect(event, '/verify-email?status=invalid', 302);
  }

  const config = useRuntimeConfig(event);
  const backendUrl = typeof config.backendUrl === 'string' ? config.backendUrl.trim() : '';
  if (backendUrl === '') {
    return sendRedirect(event, '/verify-email?status=error', 302);
  }

  const outcome = await callBackendAuth(
    { backendUrl, bffTimeoutMs: (config as { bffTimeoutMs?: number }).bffTimeoutMs ?? 10_000 },
    { method: 'POST', path: '/auth/verify-email', jsonBody: { token } },
  );

  if ('networkError' in outcome) {
    return sendRedirect(event, '/verify-email?status=error', 302);
  }
  if (outcome.status === 200) {
    return sendRedirect(event, '/verify-email?status=success', 302);
  }
  // Any non-200 (400 invalid/expired/spent) collapses to the generic invalid state.
  return sendRedirect(event, '/verify-email?status=invalid', 302);
});
