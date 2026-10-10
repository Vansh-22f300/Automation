import type { ApiErrorResponse } from "~/types/api";
import { ApiClientError } from "./api-client";

/**
 * True only for a GitHub OAuth *authorize* URL served over https on
 * `https://github.com`. The host is matched EXACTLY (not a suffix), so neither
 * `github.com.evil.test` nor `evilgithub.com` can pass, and a non-https scheme
 * is rejected. Pure predicate — the page calls it immediately before any
 * `window.location` navigation, so an unexpected or hostile value can never
 * redirect the browser off to another origin (no open redirect).
 */
export function isTrustedGithubAuthorizeUrl(value: unknown): value is string {
  if (typeof value !== "string" || value === "") return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "https:" && url.hostname === "github.com";
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
