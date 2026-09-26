import { clearSessionCookie, readSessionCookie } from '../../../utils/auth-cookie';
import { callBackendAuth, safeUpstreamError } from '../../../utils/backend-auth';

/**
 * GET /backend/auth/session — current-session probe and the source of truth for
 * the client-side route guard. GET is CSRF-exempt. Reads the opaque token from
 * the HttpOnly cookie, forwards it to Fastify `GET /auth/session` as a Bearer
 * credential, and returns only safe { user, tenant } — never the token.
 *
 *   - no cookie            → 401 unauthorized (the browser is simply logged out)
 *   - upstream 200         → { user, tenant }
 *   - upstream 401         → clear the now-dead cookie, return 401
 *   - upstream unreachable → 502/504, cookie left intact (transient failure)
 */
export default defineEventHandler(async (event): Promise<unknown> => {
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
    { method: 'GET', path: '/auth/session', token },
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
    const data = outcome.json as { user: unknown; tenant: unknown } | null;
    setResponseStatus(event, 200);
    return { user: data?.user ?? null, tenant: data?.tenant ?? null };
  }

  if (outcome.status === 401) {
    // The cookie references a session the backend no longer honours; drop it so
    // subsequent probes short-circuit to the clean logged-out response above.
    clearSessionCookie(event);
    setResponseStatus(event, 401);
    return { error: { code: 'unauthorized', message: 'Not authenticated.' } };
  }

  setResponseStatus(event, outcome.status);
  return safeUpstreamError(outcome.json);
});
