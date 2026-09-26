import { clearSessionCookie, readSessionCookie } from '../../../utils/auth-cookie';
import { callBackendAuth } from '../../../utils/backend-auth';
import { isTrustedOrigin } from '../../../utils/csrf';

/**
 * POST /backend/auth/logout — CSRF-guarded session teardown.
 *
 * Reads the opaque token from the HttpOnly cookie (never from the body or URL)
 * and best-effort revokes it upstream via Fastify `POST /auth/logout` with the
 * token as a Bearer credential. The cookie is ALWAYS cleared and the route
 * ALWAYS returns 204 — even with no cookie present, or when the backend reports
 * the session already revoked or is unreachable — so logout is deterministic
 * and idempotent from the browser's point of view.
 */
export default defineEventHandler(async (event): Promise<unknown> => {
  if (!isTrustedOrigin(event)) {
    setResponseStatus(event, 403);
    return { error: { code: 'forbidden_origin', message: 'Cross-origin request rejected.' } };
  }

  const config = useRuntimeConfig(event);
  const backendUrl = typeof config.backendUrl === 'string' ? config.backendUrl.trim() : '';
  const token = readSessionCookie(event);

  if (token !== undefined && backendUrl !== '') {
    // Best-effort: the browser session ends regardless of the upstream result.
    await callBackendAuth(
      { backendUrl, bffTimeoutMs: (config as { bffTimeoutMs?: number }).bffTimeoutMs ?? 10_000 },
      { method: 'POST', path: '/auth/logout', token },
    ).catch(() => undefined);
  }

  clearSessionCookie(event);
  setResponseStatus(event, 204);
  // Returning null lets h3 send a clean empty body while preserving the 204.
  return null;
});
