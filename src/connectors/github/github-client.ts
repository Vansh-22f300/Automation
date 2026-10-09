/**
 * A deliberately tiny GitHub REST client — the ONLY place an HTTP request to the
 * GitHub API is made, and it can reach exactly two fixed, code-defined endpoints:
 * `GET /user` (identity) and `POST /repos/{owner}/{repo}/issues` (create issue).
 *
 * This is NOT a generic HTTP layer. There is no method that takes a URL, a path,
 * a verb, or raw headers from a caller. `owner`/`repo` are the only request-shaped
 * values that reach a URL, they are validated by the tool's `.strict()` Zod schema
 * before they ever arrive here, and they are additionally `encodeURIComponent`-d
 * into a fixed path template so a value can neither add a path segment nor a query.
 * That confinement is the whole reason this exists as its own seam (mirrors
 * `slack-client.ts`).
 *
 * The access token flows into the `Authorization: Bearer` header ONLY — never a
 * query parameter, never the body, never logged. The transport resolves with a
 * {@link GithubHttpResponse} for every HTTP status (including 4xx/5xx/429) and
 * rejects only for a transport-level failure (network/timeout/abort); classifying
 * a response into the error taxonomy is the caller's job.
 */

import { GITHUB_API_BASE } from '@/oauth/providers/index.js';

/** GitHub's dated REST API version, pinned so responses never shift under us. */
export const GITHUB_API_VERSION = '2022-11-28';

/** The media type GitHub asks integrations to request. */
export const GITHUB_ACCEPT = 'application/vnd.github+json';

/**
 * A stable, identifying User-Agent. GitHub REJECTS API requests without one, so it
 * is a required, fixed, non-secret constant — never derived from request input.
 */
export const GITHUB_USER_AGENT = 'ai-workforce';

/** Per-request ceiling; a hung GitHub call aborts and becomes a retryable failure. */
export const DEFAULT_GITHUB_TIMEOUT_MS = 10_000;

/** The `fetch` surface we use, so a test can inject a stub without DOM types. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** A normalized HTTP outcome the caller interprets. Never carries the token. */
export interface GithubHttpResponse {
  readonly status: number;
  /** Parsed JSON body, or `undefined` when the body was absent/unparseable. */
  readonly body: unknown;
  /** Parsed `Retry-After` (seconds) when GitHub throttles us. */
  readonly retryAfterSeconds?: number;
  /** Parsed `x-ratelimit-remaining`, used to distinguish a rate-limit 403. */
  readonly rateLimitRemaining?: number;
}

/** The validated inputs a create-issue call needs. No token here — passed separately. */
export interface GithubCreateIssueRequest {
  readonly owner: string;
  readonly repo: string;
  readonly title: string;
  readonly body?: string;
}

/**
 * The seam the finalizer and connectors depend on. Two fixed operations; both
 * resolve with a {@link GithubHttpResponse} for any HTTP status and reject only on
 * a transport-level failure.
 */
export interface GithubTransport {
  getAuthenticatedUser(accessToken: string): Promise<GithubHttpResponse>;
  createIssue(input: GithubCreateIssueRequest, accessToken: string): Promise<GithubHttpResponse>;
}

export interface FetchGithubTransportOptions {
  /** Injectable fetch (defaults to the global). */
  readonly fetch?: FetchLike;
  /** Per-request timeout in ms (defaults to 10s). Guards a hung GitHub call. */
  readonly timeoutMs?: number;
}

/** The fixed request headers every call carries. The token is the only secret. */
function githubHeaders(accessToken: string, extra?: Record<string, string>): Record<string, string> {
  return {
    accept: GITHUB_ACCEPT,
    authorization: `Bearer ${accessToken}`,
    'x-github-api-version': GITHUB_API_VERSION,
    'user-agent': GITHUB_USER_AGENT,
    ...(extra ?? {}),
  };
}

/** Parse a `Retry-After` header (integer seconds) into a number, or undefined. */
function parseRetryAfter(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  const seconds = Number.parseInt(raw, 10);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

/** Parse `x-ratelimit-remaining` into a number, or undefined. */
function parseRateLimitRemaining(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  const remaining = Number.parseInt(raw, 10);
  return Number.isFinite(remaining) ? remaining : undefined;
}

/** Shared request/parse path for both operations. The timer always clears. */
async function request(
  fetchFn: FetchLike,
  timeoutMs: number,
  url: string,
  init: RequestInit,
): Promise<GithubHttpResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(url, { ...init, signal: controller.signal });
    // A parse failure yields `undefined`; the caller treats a non-2xx as an error
    // regardless, and a 2xx with no JSON body as a malformed response.
    const body = (await response.json().catch(() => undefined)) as unknown;
    const retryAfterSeconds = parseRetryAfter(response.headers.get('retry-after'));
    const rateLimitRemaining = parseRateLimitRemaining(response.headers.get('x-ratelimit-remaining'));
    return {
      status: response.status,
      body,
      ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
      ...(rateLimitRemaining !== undefined ? { rateLimitRemaining } : {}),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The real transport: issues the two fixed GitHub calls against the configured API
 * base with the token in the Authorization header. A timeout aborts a hung request
 * so it surfaces as a retryable transport failure.
 */
export function createFetchGithubTransport(options: FetchGithubTransportOptions = {}): GithubTransport {
  const fetchFn: FetchLike = options.fetch ?? (globalThis.fetch as FetchLike);
  const timeoutMs = options.timeoutMs ?? DEFAULT_GITHUB_TIMEOUT_MS;

  return {
    async getAuthenticatedUser(accessToken: string): Promise<GithubHttpResponse> {
      const url = new URL('/user', GITHUB_API_BASE).toString();
      return request(fetchFn, timeoutMs, url, { method: 'GET', headers: githubHeaders(accessToken) });
    },

    async createIssue(input: GithubCreateIssueRequest, accessToken: string): Promise<GithubHttpResponse> {
      // owner/repo are already validated by the tool schema; encode them anyway so a
      // value can neither open a new path segment (`/`) nor a query (`?`). The path
      // template is fixed in code — there is no way to reach any other endpoint.
      const path = `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/issues`;
      const url = new URL(path, GITHUB_API_BASE).toString();
      const payload: Record<string, string> = { title: input.title };
      if (input.body !== undefined) payload['body'] = input.body;
      return request(fetchFn, timeoutMs, url, {
        method: 'POST',
        headers: githubHeaders(accessToken, { 'content-type': 'application/json' }),
        body: JSON.stringify(payload),
      });
    },
  };
}
