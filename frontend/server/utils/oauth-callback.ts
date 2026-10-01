/**
 * Pure forwarding logic for the PUBLIC OAuth callback BFF route
 * (`server/routes/oauth/[provider]/callback.get.ts`).
 *
 * The generic OAuth foundation registers its redirect URI as
 * `${APP_ORIGIN}/oauth/:provider/callback`, and APP_ORIGIN is the public
 * FRONTEND origin (Vercel), not the Fastify API host. So the provider sends the
 * browser here, to the Nuxt BFF, which forwards the callback server-side to the
 * real Fastify endpoint and re-emits Fastify's relative redirect on this origin.
 * This module holds the parts that can be reasoned about (and unit-tested)
 * without an h3 event: the provider-slug gate, the query allowlist, the
 * redirect-target safety check, backend-URL construction, and the fetch that
 * reads Fastify's 302 without following it.
 *
 * state/code (and the OAuth error family) are sensitive. Nothing here logs them,
 * and the frontend has no request logger that could; the backend already redacts
 * them from its own request log.
 */

/** The provider foundation's slug shape (mirrors `src/oauth/provider-config.ts`). */
const PROVIDER_SLUG_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * A provider slug is forwardable only when it matches the foundation's shape.
 * This runs BEFORE the slug is interpolated into a backend URL, so a segment can
 * never smuggle a slash, dot, or percent-escape that would point the proxy at a
 * different backend path. A well-formed but unregistered provider still passes
 * here and is left to the backend's safe, uniform response — the gate rejects
 * only malformed slugs, so it is not a provider-enumeration oracle.
 */
export function isForwardableProviderSlug(value: unknown): value is string {
  return typeof value === 'string' && PROVIDER_SLUG_PATTERN.test(value);
}

/** The only callback query params relayed upstream (OAuth 2.0 §4.1.2 / §4.1.2.1). */
export const CALLBACK_QUERY_ALLOWLIST = [
  'state',
  'code',
  'error',
  'error_description',
  'error_uri',
] as const;

/**
 * Keep only the allowlisted params, each a non-empty string, values untouched.
 * A duplicated key (parsed as an array) is dropped as ambiguous. Everything else
 * the browser appended — `redirect_uri`, trackers, anything — is discarded.
 */
export function pickCallbackParams(
  query: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const key of CALLBACK_QUERY_ALLOWLIST) {
    const value = query[key];
    if (typeof value === 'string' && value !== '') picked[key] = value;
  }
  return picked;
}

/** The site-relative path used when the backend's redirect target is absent or unsafe. */
export const SAFE_FALLBACK_PATH = '/connections';

/**
 * Return `loc` only when it is a safe SITE-RELATIVE path (single leading slash,
 * no scheme, host, protocol-relative `//`, backslash trick, control char, or
 * whitespace); otherwise `null`. The real backend always redirects to a
 * site-relative return path, so this is belt-and-braces: it guarantees the
 * browser-facing Location can never carry the backend host or an open redirect.
 */
export function safeRelativeLocation(loc: string | null | undefined): string | null {
  if (typeof loc !== 'string' || loc === '') return null;
  if (!loc.startsWith('/')) return null;
  if (loc.startsWith('//') || loc.startsWith('/\\')) return null;
  if (loc.includes('\\')) return null;
  if (/[\u0000-\u001f\u007f\s]/.test(loc)) return null;
  return loc;
}

/**
 * Build the Fastify callback URL. `provider` MUST already have passed
 * `isForwardableProviderSlug`, so it is a bare `[a-z0-9-]` segment and cannot
 * alter the path. Any query already on the base URL is dropped; only the
 * allowlisted params are set.
 */
export function buildBackendCallbackUrl(
  backendUrl: string,
  provider: string,
  params: Record<string, string>,
): string {
  const url = new URL(backendUrl);
  url.pathname = `/oauth/${provider}/callback`;
  url.search = '';
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

const DEFAULT_TIMEOUT_MS = 10_000;

function clampTimeout(ms: number | undefined): number {
  if (ms === undefined || !Number.isFinite(ms) || ms < 100 || ms > 60_000) {
    return DEFAULT_TIMEOUT_MS;
  }
  return ms;
}

export interface OAuthCallbackError {
  readonly code: string;
  readonly message: string;
  readonly requestId?: string;
}

export type OAuthCallbackResult =
  | { readonly kind: 'redirect'; readonly location: string }
  | { readonly kind: 'error'; readonly status: number; readonly error: OAuthCallbackError };

const GENERIC_ERROR: OAuthCallbackError = {
  code: 'oauth_callback_error',
  message: 'The OAuth callback could not be completed.',
};

/**
 * Parse a backend `{ error: { code, message, requestId? } }` body and keep only
 * those safe fields; a non-JSON or unexpected body collapses to a generic
 * envelope so a raw backend body (which could echo provider text) never reaches
 * the browser.
 */
function safeError(status: number, text: string): OAuthCallbackResult {
  try {
    const parsed: unknown = JSON.parse(text);
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      'error' in parsed &&
      (parsed as { error: unknown }).error !== null &&
      typeof (parsed as { error: unknown }).error === 'object'
    ) {
      const err = (parsed as { error: Record<string, unknown> }).error;
      const safe: OAuthCallbackError = {
        code: typeof err.code === 'string' ? err.code : GENERIC_ERROR.code,
        message: typeof err.message === 'string' ? err.message : GENERIC_ERROR.message,
        ...(typeof err.requestId === 'string' ? { requestId: err.requestId } : {}),
      };
      return { kind: 'error', status, error: safe };
    }
  } catch {
    // fall through to the generic envelope
  }
  return { kind: 'error', status, error: GENERIC_ERROR };
}

export interface ForwardOAuthCallbackOptions {
  readonly backendUrl: string;
  readonly provider: string;
  readonly params: Record<string, string>;
  readonly timeoutMs?: number;
}

/**
 * Forward the callback to Fastify server-side and classify the reply:
 *  - a backend 3xx → `redirect` to the (validated, site-relative) return path;
 *  - any other status → a `safeError` envelope relaying only the status plus a
 *    safe code/message;
 *  - a timeout → 504, any other network failure → 502.
 *
 * `redirect: 'manual'` means we read Fastify's 302 Location ourselves and never
 * auto-follow it onto a backend path. No cookie, Authorization, or browser
 * header is forwarded: the callback is public and recovers tenant/user from the
 * sealed `oauth_states` row, so a forwarded session cookie would be both useless
 * and a needless exposure.
 */
export async function forwardOAuthCallback(
  options: ForwardOAuthCallbackOptions,
): Promise<OAuthCallbackResult> {
  const target = buildBackendCallbackUrl(options.backendUrl, options.provider, options.params);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), clampTimeout(options.timeoutMs));

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: 'GET',
      redirect: 'manual',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
  } catch {
    clearTimeout(timeoutId);
    if (controller.signal.aborted) {
      return {
        kind: 'error',
        status: 504,
        error: { code: 'upstream_timeout', message: 'The OAuth backend did not respond in time.' },
      };
    }
    return {
      kind: 'error',
      status: 502,
      error: { code: 'upstream_unreachable', message: 'The OAuth backend could not be reached.' },
    };
  }
  clearTimeout(timeoutId);

  if (upstream.status >= 300 && upstream.status < 400) {
    const safe = safeRelativeLocation(upstream.headers.get('location'));
    return { kind: 'redirect', location: safe ?? SAFE_FALLBACK_PATH };
  }

  const text = await upstream.text();
  return safeError(upstream.status, text);
}
