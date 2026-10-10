/**
 * Unit tests for the browser-side GitHub-connect client (`lib/oauth-client.ts`)
 * and its trusted-URL guard. Run in the plain `node` environment with
 * `globalThis.fetch` stubbed — no Nuxt server. They assert the client POSTs
 * same-origin to the BFF with no body, returns `{ authorizationUrl }` on success,
 * surfaces non-2xx as `ApiClientError` (status preserved), and that
 * `isTrustedGithubAuthorizeUrl` accepts ONLY the exact backend-built GitHub
 * authorize endpoint with its required params — the guard the page relies on
 * before any navigation.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { OAuthClient, isTrustedGithubAuthorizeUrl } from "../../lib/oauth-client";
import { ApiClientError } from "../../lib/api-client";

const BASE = "/backend";

/**
 * Mirrors `buildAuthorizationUrl` (src/oauth/provider-config.ts) applied to the
 * GitHub config (src/oauth/providers/github.ts): the exact endpoint plus the
 * params the backend always sets. `overrides` with a null value drops a param.
 */
function realGithubAuthorizeUrl(overrides: Record<string, string | null> = {}): string {
  const u = new URL("https://github.com/login/oauth/authorize");
  const params: Record<string, string> = {
    response_type: "code",
    client_id: "Iv1.client123",
    redirect_uri: "https://ai-worke.vercel.app/oauth/github/callback",
    state: "opaque-state-token",
    code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    code_challenge_method: "S256",
    scope: "read:user public_repo offline_access",
  };
  for (const [k, v] of Object.entries(overrides)) {
    if (v === null) delete params[k];
    else params[k] = v;
  }
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

const GOOD_URL = realGithubAuthorizeUrl();
const QUERY = new URL(GOOD_URL).search; // "?response_type=code&client_id=…"

function jsonResponse(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubFetch(response: Response | Error) {
  const mock = vi.fn(() =>
    response instanceof Error ? Promise.reject(response) : Promise.resolve(response),
  );
  vi.stubGlobal("fetch", mock);
  return mock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isTrustedGithubAuthorizeUrl", () => {
  it("accepts the exact backend-built GitHub authorize URL", () => {
    expect(isTrustedGithubAuthorizeUrl(GOOD_URL)).toBe(true);
    expect(isTrustedGithubAuthorizeUrl(realGithubAuthorizeUrl({ client_id: "other", state: "s2" }))).toBe(true);
    // Scheme + host are case-insensitive per the URL parser, so a normalized
    // equivalent is the same canonical endpoint and is accepted.
    expect(isTrustedGithubAuthorizeUrl(GOOD_URL.replace("https://github.com", "HTTPS://GitHub.com"))).toBe(true);
  });

  it("rejects wrong scheme, host look-alikes, and non-authorize paths", () => {
    expect(isTrustedGithubAuthorizeUrl(`http://github.com/login/oauth/authorize${QUERY}`)).toBe(false);
    expect(isTrustedGithubAuthorizeUrl(`https://api.github.com/login/oauth/authorize${QUERY}`)).toBe(false);
    expect(isTrustedGithubAuthorizeUrl(`https://github.com.evil.test/login/oauth/authorize${QUERY}`)).toBe(false);
    expect(isTrustedGithubAuthorizeUrl(`https://evilgithub.com/login/oauth/authorize${QUERY}`)).toBe(false);
    expect(isTrustedGithubAuthorizeUrl(`https://github.com./login/oauth/authorize${QUERY}`)).toBe(false); // trailing-dot FQDN
    expect(isTrustedGithubAuthorizeUrl(`https://github.com/oauth/authorize${QUERY}`)).toBe(false);
    expect(isTrustedGithubAuthorizeUrl(`https://github.com/login/oauth/authorizeX${QUERY}`)).toBe(false);
    expect(isTrustedGithubAuthorizeUrl(`https://github.com/login/oauth/authorize/${QUERY}`)).toBe(false); // trailing slash
    expect(isTrustedGithubAuthorizeUrl(`https://github.com/login/oauth/authorize/extra${QUERY}`)).toBe(false);
    expect(isTrustedGithubAuthorizeUrl(`https://github.com/x/login/oauth/authorize${QUERY}`)).toBe(false); // prefixed
  });

  it("rejects URL credentials, fragments, and nonstandard ports", () => {
    expect(isTrustedGithubAuthorizeUrl(`https://user:pass@github.com/login/oauth/authorize${QUERY}`)).toBe(false);
    expect(isTrustedGithubAuthorizeUrl(`${GOOD_URL}#frag`)).toBe(false);
    expect(isTrustedGithubAuthorizeUrl(`https://github.com:8443/login/oauth/authorize${QUERY}`)).toBe(false);
  });

  it("rejects a URL missing (or emptying) any required authorization parameter", () => {
    expect(isTrustedGithubAuthorizeUrl(realGithubAuthorizeUrl({ client_id: null }))).toBe(false);
    expect(isTrustedGithubAuthorizeUrl(realGithubAuthorizeUrl({ state: null }))).toBe(false);
    expect(isTrustedGithubAuthorizeUrl(realGithubAuthorizeUrl({ redirect_uri: null }))).toBe(false);
    expect(isTrustedGithubAuthorizeUrl(realGithubAuthorizeUrl({ code_challenge: null }))).toBe(false);
    expect(isTrustedGithubAuthorizeUrl(realGithubAuthorizeUrl({ state: "" }))).toBe(false);
    expect(isTrustedGithubAuthorizeUrl(realGithubAuthorizeUrl({ client_id: "" }))).toBe(false);
    expect(isTrustedGithubAuthorizeUrl(realGithubAuthorizeUrl({ redirect_uri: "" }))).toBe(false);
    expect(isTrustedGithubAuthorizeUrl(realGithubAuthorizeUrl({ code_challenge: "" }))).toBe(false);
  });

  it("rejects junk and non-github values", () => {
    expect(isTrustedGithubAuthorizeUrl("https://evil.example/login/oauth/authorize")).toBe(false);
    expect(isTrustedGithubAuthorizeUrl("javascript:alert(1)")).toBe(false);
    expect(isTrustedGithubAuthorizeUrl("//github.com/login/oauth/authorize")).toBe(false);
    expect(isTrustedGithubAuthorizeUrl("not a url")).toBe(false);
    expect(isTrustedGithubAuthorizeUrl("")).toBe(false);
    expect(isTrustedGithubAuthorizeUrl(undefined)).toBe(false);
  });
});

describe("OAuthClient.beginGithubAuthorization", () => {
  it("POSTs same-origin to the BFF with no body and returns the authorization URL", async () => {
    const mock = stubFetch(jsonResponse(200, { authorizationUrl: GOOD_URL }));
    const result = await new OAuthClient({ baseUrl: BASE }).beginGithubAuthorization();
    expect(result.authorizationUrl).toBe(GOOD_URL);
    const [reqUrl, init] = mock.mock.calls[0] as unknown as [string, RequestInit];
    expect(reqUrl).toBe("/backend/oauth/github/authorize");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("same-origin");
    expect(init.body).toBeUndefined(); // identity rides in the cookie; nothing is sent
  });

  it("throws ApiClientError(401) when the session has expired", async () => {
    stubFetch(jsonResponse(401, { error: { code: "unauthorized", message: "no" } }));
    await expect(new OAuthClient({ baseUrl: BASE }).beginGithubAuthorization()).rejects.toMatchObject({ status: 401 });
  });

  it("throws ApiClientError(404) when GitHub OAuth is not configured", async () => {
    stubFetch(jsonResponse(404, { error: { code: "not_found", message: "OAuth provider not found" } }));
    await expect(new OAuthClient({ baseUrl: BASE }).beginGithubAuthorization()).rejects.toMatchObject({ status: 404 });
  });

  it("throws ApiClientError on a backend error (500)", async () => {
    stubFetch(jsonResponse(500, { error: { code: "internal", message: "no" } }));
    await expect(new OAuthClient({ baseUrl: BASE }).beginGithubAuthorization()).rejects.toBeInstanceOf(ApiClientError);
  });

  it("throws when a 200 response omits authorizationUrl", async () => {
    stubFetch(jsonResponse(200, { nope: true }));
    await expect(new OAuthClient({ baseUrl: BASE }).beginGithubAuthorization()).rejects.toBeInstanceOf(ApiClientError);
  });

  it("maps a network failure to ApiClientError(0)", async () => {
    stubFetch(new TypeError("network down"));
    await expect(new OAuthClient({ baseUrl: BASE }).beginGithubAuthorization()).rejects.toMatchObject({ status: 0 });
  });
});
