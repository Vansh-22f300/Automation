/**
 * Nitro BFF: `/backend/*` → Fastify.
 *
 * Same-origin entry point for the browser. The browser sends GET/HEAD requests
 * to `/backend/<fastify-path>`; this handler:
 *
 *   1. Rejects non-GET/HEAD methods with 405.
 *   2. Returns 503 if NUXT_API_KEY or NUXT_BACKEND_URL is missing.
 *   3. Builds a fresh outbound request with only an allowlist of request headers.
 *      In particular: `authorization` and `cookie` are stripped (the client may
 *      have set them) and a server-only `Authorization: Bearer <NUXT_API_KEY>`
 *      is injected. Exactly one Authorization header reaches Fastify.
 *   4. Forwards the URL path and query string to Fastify.
 *   5. Enforces a bounded upstream timeout. Returns 504 on timeout.
 *   6. Surfaces upstream 2xx bodies verbatim. Wraps upstream 4xx/5xx bodies in
 *      a safe envelope derived from Fastify's `{ error: { code, message, ... } }`
 *      shape when present, otherwise a generic upstream error envelope.
 *   7. Forwards only an allowlist of response headers (content-type, cache-control,
 *      etag, vary, x-request-id). Never the upstream `set-cookie` or any
 *      echo of the API key.
 *
 * The API key value never appears in any response header, body, error envelope,
 * log line, or stack trace; the handler reads it from server-only runtime config
 * and only uses it for outbound authorization.
 */
import { getMethod, getQuery, getRequestHeaders, getRouterParam } from 'h3';
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
  const apiKey = typeof config.apiKey === 'string' ? config.apiKey.trim() : '';
  const backendUrl =
    typeof config.backendUrl === 'string' ? config.backendUrl.trim() : '';

  if (apiKey === '') {
    setResponseStatus(event, 503);
    return {
      error: {
        code: 'bff_unconfigured',
        message: 'The BFF is not configured with a server API key.',
      },
    };
  }

  if (backendUrl === '') {
    setResponseStatus(event, 503);
    return {
      error: {
        code: 'bff_unconfigured',
        message: 'The BFF is not configured with a backend URL.',
      },
    };
  }

  const pathSegments = getRouterParam(event, 'path') ?? '';
  const query = getQuery(event);

  const options: BffForwardOptions = {
    method: method as 'GET' | 'HEAD',
    backendUrl,
    apiKey,
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