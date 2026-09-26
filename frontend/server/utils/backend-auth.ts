/**
 * Server-side calls from the BFF to the Fastify human-auth endpoints. These
 * never attach the server API key: `/auth/login` is public, and `/auth/logout`
 * + `/auth/session` authenticate with the caller's opaque session token (read
 * from the HttpOnly cookie) forwarded as a Bearer token. The token and the
 * password are never logged here.
 */
interface RuntimeConfigLike {
  backendUrl: string;
  bffTimeoutMs: number;
}

const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 10_000;

function resolveTimeout(raw: unknown): number {
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(value)) return DEFAULT_TIMEOUT_MS;
  return Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, Math.floor(value)));
}

export interface UpstreamResult {
  status: number;
  json: unknown;
}

export interface UpstreamNetworkError {
  networkError: 'timeout' | 'unreachable';
}

interface CallOptions {
  method: 'GET' | 'POST';
  path: string;
  token?: string;
  jsonBody?: unknown;
}

export async function callBackendAuth(
  config: RuntimeConfigLike,
  opts: CallOptions,
): Promise<UpstreamResult | UpstreamNetworkError> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), resolveTimeout(config.bffTimeoutMs));
  const headers = new Headers({ accept: 'application/json' });
  if (opts.jsonBody !== undefined) headers.set('content-type', 'application/json');
  if (opts.token !== undefined) headers.set('authorization', `Bearer ${opts.token}`);
  try {
    const response = await fetch(`${config.backendUrl}${opts.path}`, {
      method: opts.method,
      headers,
      ...(opts.jsonBody !== undefined ? { body: JSON.stringify(opts.jsonBody) } : {}),
      signal: controller.signal,
    });
    const text = await response.text();
    let json: unknown = null;
    try {
      json = text === '' ? null : JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: response.status, json };
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'AbortError';
    return { networkError: timedOut ? 'timeout' : 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Re-shape an upstream error body into the app's safe envelope. Only a
 * whitelisted { code, message, requestId } survives; anything else collapses to
 * a generic upstream_error, so no upstream internal detail leaks to the browser.
 */
export function safeUpstreamError(
  json: unknown,
): { error: { code: string; message: string; requestId?: string } } {
  if (json !== null && typeof json === 'object' && 'error' in json) {
    const inner = (json as { error?: unknown }).error;
    if (inner !== null && typeof inner === 'object') {
      const code = (inner as { code?: unknown }).code;
      const message = (inner as { message?: unknown }).message;
      if (typeof code === 'string' && typeof message === 'string') {
        const requestId = (inner as { requestId?: unknown }).requestId;
        return {
          error: { code, message, ...(typeof requestId === 'string' ? { requestId } : {}) },
        };
      }
    }
  }
  return {
    error: { code: 'upstream_error', message: 'The request could not be completed. Please try again.' },
  };
}
