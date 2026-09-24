/**
 * Pure forward-construction logic for the `/backend/*` BFF route.
 *
 * Nitro's server route delegates here so the actual URL, headers, and
 * timeouts that reach Fastify can be reasoned about (and unit-tested)
 * independently of the h3 event object. The handler still drives the response
 * (status, headers, body); this helper only decides what to ask Fastify and
 * how to interpret Fastify's reply.
 */
export type BffBody =
  | string
  | { error: { code: string; message: string; requestId?: string } };

export interface BffForwardOptions {
  readonly method: 'GET' | 'HEAD';
  readonly backendUrl: string;
  readonly apiKey: string;
  readonly pathSegments: string;
  readonly query: Record<string, string | string[] | undefined>;
  readonly requestHeaders: Record<string, string | string[] | undefined>;
  /** Override the default upstream timeout, in milliseconds. */
  readonly timeoutMs?: number;
}

export interface BffForwardResult {
  readonly status: number;
  readonly responseHeaders: Record<string, string>;
  readonly body: BffBody | null;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Request headers we forward verbatim from the browser to Fastify. Everything
 * else is dropped, including any `authorization` or `cookie` the browser may
 * have set. The handler then injects a server-only Authorization header below.
 */
const FORWARDABLE_REQUEST_HEADERS = new Set([
  'accept',
  'accept-language',
  'accept-encoding',
  'user-agent',
]);

/**
 * Response headers we forward verbatim from Fastify to the browser.
 * `set-cookie` is deliberately NOT in this list: the browser must never
 * receive a session cookie tied to a backend that is not on the same origin.
 */
const RESPONSE_HEADER_ALLOWLIST = new Set([
  'content-type',
  'cache-control',
  'etag',
  'vary',
  'x-request-id',
]);

function readTimeoutMs(override: number | undefined): number {
  if (override === undefined) return DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(override) || override < 100 || override > 60_000) {
    return DEFAULT_TIMEOUT_MS;
  }
  return override;
}

function joinPath(base: string, pathSegments: string): URL {
  const url = new URL(base);
  const trimmed = pathSegments.startsWith('/') ? pathSegments : `/${pathSegments}`;
  // Preserve trailing slash if the caller asked for one.
  const wantsTrailing = pathSegments.endsWith('/') && trimmed !== '/';
  url.pathname = trimmed === '' ? '/' : trimmed;
  if (wantsTrailing && !url.pathname.endsWith('/')) {
    url.pathname = `${url.pathname}/`;
  }
  return url;
}

function appendSearchParams(
  url: URL,
  query: Record<string, string | string[] | undefined>,
): void {
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const v of value) url.searchParams.append(key, String(v));
    } else {
      url.searchParams.set(key, String(value));
    }
  }
}

function buildOutboundHeaders(
  incoming: Record<string, string | string[] | undefined>,
  apiKey: string,
): Headers {
  const outbound = new Headers();
  for (const [name, value] of Object.entries(incoming)) {
    const lower = name.toLowerCase();
    if (!FORWARDABLE_REQUEST_HEADERS.has(lower)) continue;
    if (Array.isArray(value)) {
      for (const v of value) outbound.append(name, v);
    } else if (value !== undefined && value !== null) {
      outbound.set(name, String(value));
    }
  }
  outbound.set('authorization', `Bearer ${apiKey}`);
  return outbound;
}

function collectForwardableResponseHeaders(upstream: Response): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of upstream.headers.entries()) {
    if (RESPONSE_HEADER_ALLOWLIST.has(name.toLowerCase())) {
      result[name.toLowerCase()] = value;
    }
  }
  return result;
}

function safeUpstreamError(text: string): BffBody | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      'error' in parsed &&
      parsed.error !== null &&
      typeof parsed.error === 'object'
    ) {
      const err = parsed.error as Record<string, unknown>;
      const safe: { code: string; message: string; requestId?: string } = {
        code: typeof err.code === 'string' ? err.code : 'upstream_error',
        message:
          typeof err.message === 'string' ? err.message : 'The backend returned an error.',
      };
      if (typeof err.requestId === 'string') safe.requestId = err.requestId;
      return { error: safe };
    }
    return null;
  } catch {
    return null;
  }
}

function makeEnvelope(code: string, message: string): BffBody {
  return { error: { code, message } };
}

export async function forwardBff(options: BffForwardOptions): Promise<BffForwardResult> {
  const targetUrl = joinPath(options.backendUrl, options.pathSegments);
  appendSearchParams(targetUrl, options.query);

  const outboundHeaders = buildOutboundHeaders(options.requestHeaders, options.apiKey);

  const controller = new AbortController();
  const timeoutMs = readTimeoutMs(options.timeoutMs);
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  let upstream: Response;
  try {
    upstream = await fetch(targetUrl, {
      method: options.method,
      headers: outboundHeaders,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeoutId);
    if (controller.signal.aborted) {
      return {
        status: 504,
        responseHeaders: {},
        body: makeEnvelope('upstream_timeout', 'The backend did not respond in time.'),
      };
    }
    return {
      status: 502,
      responseHeaders: {},
      body: makeEnvelope('upstream_unreachable', 'The backend could not be reached.'),
    };
  }
  clearTimeout(timeoutId);

  const responseHeaders = collectForwardableResponseHeaders(upstream);

  if (options.method === 'HEAD') {
    return { status: upstream.status, responseHeaders, body: null };
  }

  const text = await upstream.text();

  if (upstream.ok) {
    return { status: upstream.status, responseHeaders, body: text };
  }

  const safe = safeUpstreamError(text);
  return {
    status: upstream.status,
    responseHeaders,
    body: safe ?? makeEnvelope('upstream_error', 'The backend returned an error.'),
  };
}

export const _internals = {
  DEFAULT_TIMEOUT_MS,
  FORWARDABLE_REQUEST_HEADERS,
  RESPONSE_HEADER_ALLOWLIST,
  buildOutboundHeaders,
  joinPath,
  appendSearchParams,
  collectForwardableResponseHeaders,
  safeUpstreamError,
};