import { getQuery, getRouterParam, sendRedirect, setResponseHeader, setResponseStatus } from 'h3';

import {
  forwardOAuthCallback,
  isForwardableProviderSlug,
  pickCallbackParams,
} from '../../../utils/oauth-callback';

/**
 * GET /oauth/:provider/callback — the PUBLIC OAuth redirect endpoint, as the
 * browser sees it.
 *
 * The generic OAuth foundation registers `${APP_ORIGIN}/oauth/:provider/callback`
 * as every provider's redirect URI, and APP_ORIGIN is this public FRONTEND
 * origin — not the Fastify API host. The provider therefore sends the browser
 * HERE. This top-level BFF route (NOT a client-side fetch) forwards the callback
 * server-side to the real Fastify endpoint and re-emits Fastify's relative
 * redirect so the browser lands on `/connections` on this same origin. The
 * Fastify callback contract is unchanged; this is pure deployment routing.
 *
 * Security: `state`/`code` (and the OAuth error family) are sensitive and never
 * logged here; the slug is shape-gated before it can shape a backend URL; only
 * the OAuth params are forwarded (values byte-exact); the backend base URL comes
 * from server-only runtime config, never from the request; and the browser-facing
 * redirect is always a validated site-relative path, so the backend host can
 * never leak and the endpoint can never become an open redirect.
 */
export default defineEventHandler(async (event): Promise<unknown> => {
  const provider = getRouterParam(event, 'provider');
  if (!isForwardableProviderSlug(provider)) {
    // Malformed slug: reject locally without ever building a backend URL from it.
    // 400 mirrors the backend callback's own bad-input status for a bad request.
    setResponseStatus(event, 400);
    setResponseHeader(event, 'content-type', 'application/json');
    return { error: { code: 'bad_request', message: 'Unknown OAuth provider.' } };
  }

  const config = useRuntimeConfig(event);
  const backendUrl = typeof config.backendUrl === 'string' ? config.backendUrl.trim() : '';
  if (backendUrl === '') {
    setResponseStatus(event, 503);
    setResponseHeader(event, 'content-type', 'application/json');
    return { error: { code: 'bff_unconfigured', message: 'The OAuth backend is not configured.' } };
  }

  const params = pickCallbackParams(
    getQuery(event) as Record<string, string | string[] | undefined>,
  );

  const result = await forwardOAuthCallback({
    backendUrl,
    provider,
    params,
    timeoutMs: (config as { bffTimeoutMs?: number }).bffTimeoutMs,
  });

  if (result.kind === 'redirect') {
    // Validated site-relative path → the browser resolves it against THIS origin.
    return sendRedirect(event, result.location, 302);
  }

  setResponseStatus(event, result.status);
  setResponseHeader(event, 'content-type', 'application/json');
  return { error: result.error };
});
