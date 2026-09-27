/**
 * Nitro BFF data plane: `/backend/*` → Fastify.
 *
 * Same-origin entry point for the browser. The browser sends GET/HEAD requests
 * to `/backend/<fastify-path>`; this handler:
 *
 *   1. Rejects non-GET/HEAD methods with 405.
 *   2. Returns 503 if NUXT_BACKEND_URL is missing.
 *   3. Reads the HttpOnly `aw_session` cookie server-side and forwards the
 *      human's opaque session token as the upstream credential. It builds a
 *      fresh outbound request with only an allowlist of request headers: any
 *      browser-supplied `authorization` and `cookie` are stripped, and a single
 *      server-derived `Authorization: Bearer <session-token>` is injected when
 *      a session exists. With no session cookie no Authorization is sent and
 *      Fastify decides (public routes answer; `/v1/*` returns 401). Exactly one
 *      Authorization header — chosen by the server, never the browser — reaches
 *      Fastify, so the backend's session authenticator alone establishes the
 *      user and tenant. The machine API key is never used on this plane.
 *   4. Forwards the URL path and query string to Fastify.
 *   5. Enforces a bounded upstream timeout. Returns 504 on timeout.
 *   6. Surfaces upstream 2xx bodies verbatim. Wraps upstream 4xx/5xx bodies in
 *      a safe envelope derived from Fastify's `{ error: { code, message, ... } }`
 *      shape when present, otherwise a generic upstream error envelope.
 *   7. Forwards only an allowlist of response headers (content-type, cache-control,
 *      etag, vary, x-request-id). Never the upstream `set-cookie`.
 *
 * The session token never appears in any response header, body, error envelope,
 * log line, or stack trace; the handler reads it from the HttpOnly cookie and
 * only uses it for outbound authorization. It is never exposed to browser JS.
 */
import { getMethod, getQuery, getRequestHeaders, getRouterParam } from 'h3';
import { readSessionCookie } from '../../utils/auth-cookie';
import {
  type BffForwardOptions,
  type BffForwardResult,
  forwardBff,
} from '../../utils/bff-forward';

const ALLOWED_METHODS = new Set(['GET', 'HEAD']);
const ALLOW_LIST = 'GET, HEAD';

/**
 * Resolve the upstream timeout from server-only runtime config.
 * Falls back to 10 s if the value is missing or out of range.
 */
function readTimeoutMs(config: ReturnType<typeof useRuntimeConfig>): number {
  const raw = (config as { bffTimeoutMs?: unknown }).bffTimeoutMs;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 10_000;
  if (raw < 100 || raw > 60_000) return 10_000;
  return raw;
}

export default defineEventHandler(async (event): Promise<unknown> => {
  const method = getMethod(event);

  if (!ALLOWED_METHODS.has(method)) {
    setResponseHeader(event, 'allow', ALLOW_LIST);
    setResponseStatus(event, 405);
    return {
      error: {
        code: 'method_not_allowed',
        message: 'Only GET or HEAD requests are allowed on this endpoint.',
      },
    };
  }

  const config = useRuntimeConfig(event);
  const backendUrl =
    typeof config.backendUrl === 'string' ? config.backendUrl.trim() : '';

  if (backendUrl === '') {
    setResponseStatus(event, 503);
    return {
      error: {
        code: 'bff_unconfigured',
        message: 'The BFF is not configured with a backend URL.',
      },
    };
  }

  // The only credential this plane forwards is the human's own session token,
  // read server-side from the HttpOnly cookie. It is never readable by browser
  // JS and never chosen by the caller. When absent we forward nothing and let
  // Fastify reject protected routes; the machine API key is not used here.
  const sessionToken = readSessionCookie(event);

  const pathSegments = getRouterParam(event, 'path') ?? '';
  const query = getQuery(event);

  const options: BffForwardOptions = {
    method: method as 'GET' | 'HEAD',
    backendUrl,
    bearerToken: sessionToken,
    pathSegments,
    query: query as Record<string, string | string[] | undefined>,
    requestHeaders: getRequestHeaders(event) as Record<string, string | string[] | undefined>,
    timeoutMs: readTimeoutMs(config),
  };

  const result: BffForwardResult = await forwardBff(options);

  setResponseStatus(event, result.status);

  for (const [name, value] of Object.entries(result.responseHeaders)) {
    setResponseHeader(event, name, value);
  }

  if (method === 'HEAD') {
    // Send an empty body while preserving the upstream status set above.
    // Returning `null` would trigger h3's `sendNoContent`, which forces a 204
    // and discards the real upstream status (e.g. a 200 HEAD would surface as
    // 204). An empty string sends no body but keeps the status code and the
    // already-set, allowlisted `content-type` header intact.
    return '';
  }

  return result.body;
});