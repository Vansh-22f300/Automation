import { readBody } from 'h3';
import { setSessionCookie } from '../../../utils/auth-cookie';
import { callBackendAuth, safeUpstreamError } from '../../../utils/backend-auth';
import { isTrustedOrigin } from '../../../utils/csrf';

/**
 * POST /backend/auth/signup — public self-serve signup boundary.
 *
 * The account-creation mirror of `login.post.ts`. CSRF-guarded by Origin/Referer.
 * Forwards { name, email, password, workspaceName } to Fastify `POST /auth/signup`
 * server-side with NO credential attached (the endpoint is public; attaching the
 * server API key would be needless privilege and could mask the intended human
 * path). On the upstream 201 it writes the brand-new opaque session token into
 * the HttpOnly `aw_session` cookie and returns only safe metadata — never the
 * token, never a password — so the raw credential never becomes browser-readable
 * and the new owner is authenticated immediately, exactly as a login would be.
 *
 * The browser never supplies (and can never smuggle) a tenant id, user id, or
 * role: only the four account facts are forwarded, and the backend derives all
 * ownership server-side.
 */
interface SignupSuccess {
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

  const body = (await readBody(event).catch(() => null)) as
    | { name?: unknown; email?: unknown; password?: unknown; workspaceName?: unknown }
    | null;
  const name = body?.name;
  const email = body?.email;
  const password = body?.password;
  const workspaceName = body?.workspaceName;
  if (
    typeof name !== 'string' || name === '' ||
    typeof email !== 'string' || email === '' ||
    typeof password !== 'string' || password === '' ||
    typeof workspaceName !== 'string' || workspaceName === ''
  ) {
    setResponseStatus(event, 400);
    return { error: { code: 'bad_request', message: 'Name, email, password, and workspace name are required.' } };
  }

  const outcome = await callBackendAuth(
    { backendUrl, bffTimeoutMs: (config as { bffTimeoutMs?: number }).bffTimeoutMs ?? 10_000 },
    { method: 'POST', path: '/auth/signup', jsonBody: { name, email, password, workspaceName } },
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

  if (outcome.status === 201) {
    const data = outcome.json as SignupSuccess | null;
    const token = data?.session?.token;
    const expiresAt = data?.session?.expiresAt;
    if (typeof token !== 'string' || typeof expiresAt !== 'string') {
      setResponseStatus(event, 502);
      return { error: { code: 'upstream_error', message: 'The request could not be completed. Please try again.' } };
    }
    setSessionCookie(event, token, expiresAt);
    setResponseStatus(event, 201);
    // The raw token is intentionally omitted from the browser-facing response.
    return { user: data!.user, tenant: data!.tenant, session: { expiresAt } };
  }

  setResponseStatus(event, outcome.status);
  return safeUpstreamError(outcome.json);
});
