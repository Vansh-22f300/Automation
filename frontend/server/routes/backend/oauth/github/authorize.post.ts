import { readSessionCookie } from '../../../../utils/auth-cookie';
import { callBackendAuth, safeUpstreamError } from '../../../../utils/backend-auth';
import { isTrustedOrigin } from '../../../../utils/csrf';

/**
 * POST /backend/oauth/github/authorize — begin GitHub OAuth for the signed-in human.
 *
 * A NARROW, fixed-purpose companion to the GET/HEAD-only `/backend/*` data plane
 * (which it does not touch and does not relax). It starts exactly one flow —
 * GitHub authorization — and nothing about it is caller-shaped:
 *
 *   - CSRF-guarded by the shared same-origin check (SameSite=Lax is not enough),
 *     so a cross-origin caller is refused before any upstream work.
 *   - The ONLY credential forwarded is the human's opaque session token, read
 *     server-side from the HttpOnly `aw_session` cookie and sent as a single
 *     server-derived `Authorization: Bearer …`. A browser-supplied Authorization
 *     or Cookie header is never read here, and the machine `NUXT_API_KEY` is
 *     never attached: OAuth is a human action, so a machine identity must not be
 *     able to start it.
 *   - The upstream path, method, and body are HARD-CODED. The browser cannot pass
 *     a tenantId, userId, provider, scope override, or returnPath; the body is the
 *     fixed {@link AUTHORIZE_BODY}, which the backend re-validates as a safe
 *     internal path.
 *   - No session cookie ⇒ 401 and NO upstream request is made.
 *   - Bounded upstream timeout; only a sanitized `{ error: { code, message } }`
 *     envelope or `{ authorizationUrl }` is ever returned — never the token, a
 *     cookie, or a raw provider body.
 */

/** The single Fastify endpoint this route may ever call. */
const AUTHORIZE_PATH = '/v1/oauth/github/authorize';

/**
 * Server-fixed body. The backend re-validates `returnPath` as a safe internal
 * path. The `connected=github` marker only tells the returning `/connections`
 * page to re-check its metadata; it is never treated as proof that a connection
 * was created.
 */
const AUTHORIZE_BODY = { returnPath: '/connections?connected=github' } as const;

export default defineEventHandler(async (event): Promise<unknown> => {
  // CSRF first: a cross-origin caller gets nothing and no upstream work happens.
  if (!isTrustedOrigin(event)) {
    setResponseStatus(event, 403);
    return { error: { code: 'forbidden_origin', message: 'Cross-origin request rejected.' } };
  }

  // The human session is required and comes ONLY from the HttpOnly cookie. With
  // no session we reject here and never begin an OAuth flow upstream.
  const token = readSessionCookie(event);
  if (token === undefined || token === '') {
    setResponseStatus(event, 401);
    return { error: { code: 'unauthorized', message: 'You must be signed in to connect GitHub.' } };
  }

  const config = useRuntimeConfig(event);
  const backendUrl = typeof config.backendUrl === 'string' ? config.backendUrl.trim() : '';
  if (backendUrl === '') {
    setResponseStatus(event, 503);
    return { error: { code: 'bff_unconfigured', message: 'The BFF is not configured with a backend URL.' } };
  }

  const outcome = await callBackendAuth(
    { backendUrl, bffTimeoutMs: (config as { bffTimeoutMs?: number }).bffTimeoutMs ?? 10_000 },
    { method: 'POST', path: AUTHORIZE_PATH, token, jsonBody: AUTHORIZE_BODY },
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
    const data = outcome.json as { authorizationUrl?: unknown } | null;
    const authorizationUrl = data?.authorizationUrl;
    if (typeof authorizationUrl !== 'string' || authorizationUrl === '') {
      setResponseStatus(event, 502);
      return { error: { code: 'upstream_error', message: 'The request could not be completed. Please try again.' } };
    }
    setResponseStatus(event, 200);
    // Return ONLY the authorization URL — never the session token or any cookie.
    return { authorizationUrl };
  }

  // 400/401/403/404/500 → relay a sanitized envelope carrying the upstream status.
  // 404 is the disabled-provider state (GitHub OAuth not configured): the backend
  // registry fails closed and non-enumerably, and this surfaces it unchanged.
  setResponseStatus(event, outcome.status);
  return safeUpstreamError(outcome.json);
});
