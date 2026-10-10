/**
 * Unit tests for the browser-side GitHub-connect client (`lib/oauth-client.ts`)
 * and its trusted-URL guard. Run in the plain `node` environment with
 * `globalThis.fetch` stubbed — no Nuxt server. They assert the client POSTs
 * same-origin to the BFF with no body, returns `{ authorizationUrl }` on success,
 * surfaces non-2xx as `ApiClientError` (status preserved), and that
 * `isTrustedGithubAuthorizeUrl` only accepts an https://github.com URL — the
 * guard the page relies on before any navigation.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { OAuthClient, isTrustedGithubAuthorizeUrl } from "../../lib/oauth-client";
import { ApiClientError } from "../../lib/api-client";

const BASE = "/backend";
const GOOD_URL = "https://github.com/login/oauth/authorize?client_id=x&state=y";

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
  it("accepts an https://github.com authorize URL", () => {
    expect(isTrustedGithubAuthorizeUrl(GOOD_URL)).toBe(true);
  });

  it("rejects non-https, other hosts, look-alikes, and junk", () => {
    expect(isTrustedGithubAuthorizeUrl("http://github.com/login/oauth/authorize")).toBe(false);
    expect(isTrustedGithubAuthorizeUrl("https://api.github.com/x")).toBe(false);
    expect(isTrustedGithubAuthorizeUrl("https://github.com.evil.test/x")).toBe(false);
    expect(isTrustedGithubAuthorizeUrl("https://evilgithub.com/x")).toBe(false);
    expect(isTrustedGithubAuthorizeUrl("https://evil.example/login/oauth/authorize")).toBe(false);
    expect(isTrustedGithubAuthorizeUrl("javascript:alert(1)")).toBe(false);
    expect(isTrustedGithubAuthorizeUrl("//github.com/x")).toBe(false);
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
    await expect(
      new OAuthClient({ baseUrl: BASE }).beginGithubAuthorization(),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("throws ApiClientError(404) when GitHub OAuth is not configured", async () => {
    stubFetch(jsonResponse(404, { error: { code: "not_found", message: "OAuth provider not found" } }));
    await expect(
      new OAuthClient({ baseUrl: BASE }).beginGithubAuthorization(),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("throws ApiClientError on a backend error (500)", async () => {
    stubFetch(jsonResponse(500, { error: { code: "internal", message: "no" } }));
    await expect(
      new OAuthClient({ baseUrl: BASE }).beginGithubAuthorization(),
    ).rejects.toBeInstanceOf(ApiClientError);
  });

  it("throws when a 200 response omits authorizationUrl", async () => {
    stubFetch(jsonResponse(200, { nope: true }));
    await expect(
      new OAuthClient({ baseUrl: BASE }).beginGithubAuthorization(),
    ).rejects.toBeInstanceOf(ApiClientError);
  });

  it("maps a network failure to ApiClientError(0)", async () => {
    stubFetch(new TypeError("network down"));
    await expect(
      new OAuthClient({ baseUrl: BASE }).beginGithubAuthorization(),
    ).rejects.toMatchObject({ status: 0 });
  });
});
