import type { ApiErrorResponse } from "~/types/api";
import { ApiClientError } from "./api-client";

/** The exact GitHub authorize endpoint path the backend builds. */
const GITHUB_AUTHORIZE_PATHNAME = "/login/oauth/authorize";

/**
 * Authorization-request params the backend always sets (see `buildAuthorizationUrl`
 * in `src/oauth/provider-config.ts`); every one is required here.
 */
const REQUIRED_AUTHORIZE_PARAMS = ["client_id", "state", "redirect_uri", "code_challenge"] as const;

/**
 * True only for the exact GitHub OAuth *authorize* endpoint the backend is
 * configured to build — `https://github.com/login/oauth/authorize` (see
 * `src/oauth/providers/github.ts` + `buildAuthorizationUrl` in
 * `src/oauth/provider-config.ts`). Beyond scheme + host it also requires: no URL
 * credentials (`user:pass@`), no fragment, the default port only, the exact
 * `/login/oauth/authorize` path, and the params the backend always sets —
 * `client_id`, `state`, `redirect_uri`, `code_challenge` — each present and
 * non-empty. Pure predicate — the page calls it immediately before any
 * `window.location` navigation, so a hostile or malformed value can never redirect
 * the browser off to another origin or to a non-authorize GitHub path.
 */
export function isTrustedGithubAuthorizeUrl(value: unknown): value is string {
  if (typeof value !== "string" || value === "") return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (url.username !== "" || url.password !== "") return false; // no embedded credentials
  if (url.hostname !== "github.com") return false;
  if (url.port !== "") return false; // default (443) only — reject nonstandard ports
  if (url.hash !== "") return false; // no fragment
  if (url.pathname !== GITHUB_AUTHORIZE_PATHNAME) return false; // exact authorize endpoint
  for (const key of REQUIRED_AUTHORIZE_PARAMS) {
    const param = url.searchParams.get(key);
    if (param === null || param === "") return false;
  }
  return true;
}

interface OAuthClientOptions {
  readonly baseUrl: string;
}

/**
 * Browser-side GitHub-connect client for the same-origin Nuxt BFF.
 *
 * Talks ONLY to the BFF at `<baseUrl>/oauth/github/authorize` (never to Fastify
 * directly). It sends no body and no credential of its own: identity rides in
 * the HttpOnly `aw_session` cookie, which the browser attaches automatically for
 * this same-origin request (`credentials: 'same-origin'`). Nothing here reads,
 * stores, or returns a session or OAuth token — the only datum returned is the
 * provider authorization URL for the caller to navigate to.
 */
export class OAuthClient {
  constructor(private readonly options: OAuthClientOptions) {}

  /**
   * POST /oauth/github/authorize — begin a GitHub OAuth connection. Resolves with
   * the provider authorization URL on success; throws {@link ApiClientError}
   * (carrying the BFF status — e.g. 401 expired session, 403 CSRF, 404 GitHub not
   * configured) on any non-2xx, so the page can render a generic, status-specific
   * message. The returned URL is still re-validated by the page before navigation.
   */
  async beginGithubAuthorization(): Promise<{ authorizationUrl: string }> {
    let response: Response;
    try {
      response = await fetch(`${this.options.baseUrl}/oauth/github/authorize`, {
        method: "POST",
        headers: new Headers({ Accept: "application/json" }),
        // The HttpOnly session cookie must ride along to the same-origin BFF.
        credentials: "same-origin",
      });
    } catch {
      throw new ApiClientError(0, "The server could not be reached. Please try again.");
    }

    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as ApiErrorResponse | null;
      throw new ApiClientError(
        response.status,
        body?.error.message ?? "The request could not be completed. Please try again.",
      );
    }

    const data = (await response.json().catch(() => null)) as {
      authorizationUrl?: unknown;
    } | null;
    const url = data?.authorizationUrl;
    if (typeof url !== "string" || url === "") {
      throw new ApiClientError(
        response.status,
        "The server returned an unexpected response. Please try again.",
      );
    }
    return { authorizationUrl: url };
  }
}
