import { readBody } from 'h3';
import { setSessionCookie } from '../../../utils/auth-cookie';
import { callBackendAuth, safeUpstreamError } from '../../../utils/backend-auth';
import { isTrustedOrigin } from '../../../utils/csrf';

/**
 * POST /backend/auth/login — public login boundary.
 *
 * CSRF-guarded. Forwards { email, password } to Fastify `POST /auth/login`
 * server-side with NO credential attached (that endpoint is public; attaching
 * the server API key would be needless privilege and could mask the intended
 * human-auth path). On success it writes the opaque session token into the
 * HttpOnly `aw_session` cookie and returns only safe metadata — never the
 * token — so the raw credential never becomes browser-readable.
 */
interface LoginSuccess {
  user: unknown;
  tenant: unknown;
  session: { token: string; expiresAt: string };
}

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

  const body = (await readBody(event).catch(() => null)) as { email?: unknown; password?: unknown } | null;
  const email = body?.email;
  const password = body?.password;
  if (typeof email !== 'string' || email === '' || typeof password !== 'string' || password === '') {
    setResponseStatus(event, 400);
    return { error: { code: 'bad_request', message: 'Email and password are required.' } };
  }

  const outcome = await callBackendAuth(
    { backendUrl, bffTimeoutMs: (config as { bffTimeoutMs?: number }).bffTimeoutMs ?? 10_000 },
    { method: 'POST', path: '/auth/login', jsonBody: { email, password } },
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
    const data = outcome.json as LoginSuccess | null;
    const token = data?.session?.token;
    const expiresAt = data?.session?.expiresAt;
    if (typeof token !== 'string' || typeof expiresAt !== 'string') {
      setResponseStatus(event, 502);
      return { error: { code: 'upstream_error', message: 'The request could not be completed. Please try again.' } };
    }
    setSessionCookie(event, token, expiresAt);
    setResponseStatus(event, 200);
    // The raw token is intentionally omitted from the browser-facing response.
    return { user: data!.user, tenant: data!.tenant, session: { expiresAt } };
  }

  setResponseStatus(event, outcome.status);
  return safeUpstreamError(outcome.json);
});
