/**
 * Unit tests for the browser-side human-auth client (`lib/auth-client.ts`).
 *
 * These run in the plain `node` environment with `globalThis.fetch` stubbed —
 * no Nuxt server — and assert the client's contract with the same-origin BFF:
 * the HttpOnly cookie is opted in via `credentials: 'same-origin'`, a 401 is a
 * clean logged-out `null` (not an error), backend failures surface as
 * `ApiClientError` (with the upstream status preserved for the login page's
 * generic messaging), the login body is exactly `{ email, password }`, and
 * logout is deterministic — it never rejects.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthClient } from "../../lib/auth-client";
import { ApiClientError } from "../../lib/api-client";

const BASE = "/backend";

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

function callArgs(mock: ReturnType<typeof stubFetch>): [string, RequestInit] {
  const [url, init] = mock.mock.calls[0] as unknown as [string, RequestInit];
  return [url, init];
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AuthClient.getSession", () => {
  it("returns { user, tenant } and opts the cookie in via same-origin on 200", async () => {
    const mock = stubFetch(
      jsonResponse(200, {
        user: { id: "u1", email: "a@b.test", name: "A" },
        tenant: { id: "t1", name: "T" },
      }),
    );
    const session = await new AuthClient({ baseUrl: BASE }).getSession();
    expect(session?.user.email).toBe("a@b.test");
    expect(session?.tenant.id).toBe("t1");
    const [url, init] = callArgs(mock);
    expect(url).toBe("/backend/auth/session");
    expect(init.method).toBe("GET");
    expect(init.credentials).toBe("same-origin");
  });

  it("returns null on 401 (cleanly logged out, not an error)", async () => {
    stubFetch(jsonResponse(401, { error: { code: "unauthorized", message: "no" } }));
    expect(await new AuthClient({ baseUrl: BASE }).getSession()).toBeNull();
  });

  it("returns null when a 200 body carries no identity", async () => {
    stubFetch(jsonResponse(200, { user: null, tenant: null }));
    expect(await new AuthClient({ baseUrl: BASE }).getSession()).toBeNull();
  });

  it("throws ApiClientError on a backend failure (502)", async () => {
    stubFetch(jsonResponse(502, { error: { code: "upstream_unreachable", message: "no" } }));
    await expect(new AuthClient({ baseUrl: BASE }).getSession()).rejects.toBeInstanceOf(
      ApiClientError,
    );
  });

  it("maps a network failure to ApiClientError(0)", async () => {
    stubFetch(new TypeError("network down"));
    await expect(new AuthClient({ baseUrl: BASE }).getSession()).rejects.toMatchObject({
      status: 0,
    });
  });
});

describe("AuthClient.login", () => {
  it("POSTs { email, password } same-origin and returns metadata (no token)", async () => {
    const mock = stubFetch(
      jsonResponse(200, {
        user: { id: "u1", email: "a@b.test", name: "A" },
        tenant: { id: "t1", name: "T" },
        session: { expiresAt: "2099-01-01T00:00:00.000Z" },
      }),
    );
    const result = await new AuthClient({ baseUrl: BASE }).login("a@b.test", "pw");
    expect(result.session.expiresAt).toBe("2099-01-01T00:00:00.000Z");
    expect((result.session as { token?: string }).token).toBeUndefined();
    const [url, init] = callArgs(mock);
    expect(url).toBe("/backend/auth/login");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("same-origin");
    expect(JSON.parse(init.body as string)).toEqual({ email: "a@b.test", password: "pw" });
    expect(new Headers(init.headers).get("content-type")).toBe("application/json");
  });

  it("throws ApiClientError(401) for bad credentials", async () => {
    stubFetch(jsonResponse(401, { error: { code: "unauthorized", message: "Invalid." } }));
    await expect(new AuthClient({ baseUrl: BASE }).login("a@b.test", "wrong")).rejects.toMatchObject(
      { status: 401 },
    );
  });

  it("preserves a 429 rate-limit status for the login page's messaging", async () => {
    stubFetch(jsonResponse(429, { error: { code: "rate_limited", message: "slow down" } }));
    await expect(new AuthClient({ baseUrl: BASE }).login("a@b.test", "pw")).rejects.toMatchObject({
      status: 429,
    });
  });
});

describe("AuthClient.logout", () => {
  it("POSTs same-origin and resolves on 204", async () => {
    const mock = stubFetch(jsonResponse(204));
    await expect(new AuthClient({ baseUrl: BASE }).logout()).resolves.toBeUndefined();
    const [url, init] = callArgs(mock);
    expect(url).toBe("/backend/auth/logout");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("same-origin");
  });

  it("never rejects, even on network failure (deterministic teardown)", async () => {
    stubFetch(new TypeError("network down"));
    await expect(new AuthClient({ baseUrl: BASE }).logout()).resolves.toBeUndefined();
  });
});
