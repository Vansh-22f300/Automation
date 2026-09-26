import type { ApiErrorResponse, AuthSession, LoginResponse } from "~/types/api";
import { ApiClientError } from "./api-client";

interface AuthClientOptions {
  readonly baseUrl: string;
}

/**
 * Browser-side human-auth client for the same-origin Nuxt BFF.
 *
 * This talks ONLY to the BFF at `<baseUrl>/auth/*` (never to Fastify directly).
 * The opaque session token is never sent, received, or stored here: it lives
 * exclusively in the HttpOnly `aw_session` cookie that the browser attaches
 * automatically. Every request therefore sets `credentials: 'same-origin'` so
 * that cookie rides along to the BFF, and nothing in this module ever reads or
 * persists a token — the browser-facing responses carry only safe metadata.
 */
export class AuthClient {
  constructor(private readonly options: AuthClientOptions) {}

  /**
   * GET /auth/session — the source of truth for the route guard.
   *   - 200 → the authenticated identity `{ user, tenant }`
   *   - 401 → `null` (the browser is simply logged out; not an error)
   *   - anything else (5xx / unreachable) → throws `ApiClientError` so callers
   *     can distinguish "backend unavailable" from "logged out".
   */
  async getSession(): Promise<AuthSession | null> {
    const response = await this.send("/auth/session", "GET");
    if (response.status === 401) return null;
    if (!response.ok) throw await this.toError(response);

    const data = (await response.json().catch(() => null)) as {
      user?: AuthSession["user"] | null;
      tenant?: AuthSession["tenant"] | null;
    } | null;
    if (data == null || data.user == null || data.tenant == null) return null;
    return { user: data.user, tenant: data.tenant };
  }

  /**
   * POST /auth/login — forwards credentials to the BFF, which sets the HttpOnly
   * cookie server-side. Returns only safe metadata (never the token). Throws
   * `ApiClientError` (carrying the upstream status) on any non-2xx response so
   * the login page can render a generic, status-appropriate message.
   */
  async login(email: string, password: string): Promise<LoginResponse> {
    const response = await this.send(
      "/auth/login",
      "POST",
      JSON.stringify({ email, password }),
    );
    if (!response.ok) throw await this.toError(response);
    return (await response.json()) as LoginResponse;
  }

  /**
   * POST /auth/logout — best-effort teardown. The BFF always clears the cookie
   * and always answers 204, so from the browser's point of view logout is
   * deterministic: this never rejects, even if the request fails.
   */
  async logout(): Promise<void> {
    await this.send("/auth/logout", "POST").catch(() => undefined);
  }

  private async send(
    path: string,
    method: "GET" | "POST",
    body?: string,
  ): Promise<Response> {
    const headers = new Headers({ Accept: "application/json" });
    if (body !== undefined) headers.set("Content-Type", "application/json");

    try {
      return await fetch(`${this.options.baseUrl}${path}`, {
        method,
        headers,
        body,
        // The HttpOnly session cookie must ride along to the same-origin BFF.
        credentials: "same-origin",
      });
    } catch {
      throw new ApiClientError(
        0,
        "The backend could not be reached. Start the Fastify API and try again.",
      );
    }
  }

  private async toError(response: Response): Promise<ApiClientError> {
    const body = (await response
      .json()
      .catch(() => null)) as ApiErrorResponse | null;
    return new ApiClientError(
      response.status,
      body?.error.message ??
        "The request could not be completed. Please try again.",
    );
  }
}
