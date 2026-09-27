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

describe("AuthClient.signup", () => {
  it("POSTs { name, email, password, workspaceName } same-origin and returns metadata (no token)", async () => {
    const mock = stubFetch(
      jsonResponse(201, {
        user: { id: "u1", email: "ada@acme.test", name: "Ada" },
        tenant: { id: "t1", name: "Acme Inc" },
        session: { expiresAt: "2099-01-01T00:00:00.000Z" },
      }),
    );
    const result = await new AuthClient({ baseUrl: BASE }).signup(
      "Ada",
      "ada@acme.test",
      "super secret pw",
      "Acme Inc",
    );
    expect(result.user.email).toBe("ada@acme.test");
    expect(result.tenant.name).toBe("Acme Inc");
    expect(result.session.expiresAt).toBe("2099-01-01T00:00:00.000Z");
    expect((result.session as { token?: string }).token).toBeUndefined();
    const [url, init] = callArgs(mock);
    expect(url).toBe("/backend/auth/signup");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("same-origin");
    expect(JSON.parse(init.body as string)).toEqual({
      name: "Ada",
      email: "ada@acme.test",
      password: "super secret pw",
      workspaceName: "Acme Inc",
    });
    expect(new Headers(init.headers).get("content-type")).toBe("application/json");
  });

  it("throws ApiClientError(409) for a duplicate email, preserving the generic status", async () => {
    stubFetch(
      jsonResponse(409, {
        error: { code: "email_unavailable", message: "That email address cannot be used to create an account." },
      }),
    );
    await expect(
      new AuthClient({ baseUrl: BASE }).signup("A", "taken@b.test", "super secret pw", "WS"),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("throws ApiClientError(400) when the backend rejects the input", async () => {
    stubFetch(jsonResponse(400, { error: { code: "bad_request", message: "Invalid." } }));
    await expect(
      new AuthClient({ baseUrl: BASE }).signup("A", "bad", "short", "WS"),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("maps a network failure to ApiClientError(0)", async () => {
    stubFetch(new TypeError("network down"));
    await expect(
      new AuthClient({ baseUrl: BASE }).signup("A", "a@b.test", "super secret pw", "WS"),
    ).rejects.toMatchObject({ status: 0 });
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

describe("AuthClient.resendVerification", () => {
  it("POSTs the resend route same-origin with no body and returns the message", async () => {
    const mock = stubFetch(jsonResponse(200, { message: "Verification email sent." }));
    const result = await new AuthClient({ baseUrl: BASE }).resendVerification();
    expect(result.message).toBe("Verification email sent.");
    const [url, init] = callArgs(mock);
    expect(url).toBe("/backend/auth/email-verification/resend");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("same-origin");
    expect(init.body).toBeUndefined(); // identity comes from the cookie, not a body
  });

  it("preserves a 429 status so the caller can render a throttled message", async () => {
    stubFetch(jsonResponse(429, { error: { code: "rate_limited", message: "slow down" } }));
    await expect(new AuthClient({ baseUrl: BASE }).resendVerification()).rejects.toMatchObject({
      status: 429,
    });
  });

  it("preserves a 401 status when the browser is logged out", async () => {
    stubFetch(jsonResponse(401, { error: { code: "unauthorized", message: "no" } }));
    await expect(new AuthClient({ baseUrl: BASE }).resendVerification()).rejects.toMatchObject({
      status: 401,
    });
  });
});

describe("AuthClient.forgotPassword", () => {
  it("POSTs { email } same-origin and returns the generic message", async () => {
    const mock = stubFetch(
      jsonResponse(202, { message: "If an account exists, password reset instructions will be sent." }),
    );
    const result = await new AuthClient({ baseUrl: BASE }).forgotPassword("a@b.test");
    expect(result.message).toContain("If an account exists");
    const [url, init] = callArgs(mock);
    expect(url).toBe("/backend/auth/forgot-password");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("same-origin");
    expect(JSON.parse(init.body as string)).toEqual({ email: "a@b.test" });
  });

  it("maps a network failure to ApiClientError(0)", async () => {
    stubFetch(new TypeError("network down"));
    await expect(
      new AuthClient({ baseUrl: BASE }).forgotPassword("a@b.test"),
    ).rejects.toMatchObject({ status: 0 });
  });
});

describe("AuthClient.resetPassword", () => {
  it("POSTs ONLY { password } — never a token — and returns the message", async () => {
    const mock = stubFetch(
      jsonResponse(200, { message: "Your password has been reset. Please sign in with your new password." }),
    );
    const result = await new AuthClient({ baseUrl: BASE }).resetPassword("brand-new-pw");
    expect(result.message).toContain("has been reset");
    const [url, init] = callArgs(mock);
    expect(url).toBe("/backend/auth/reset-password");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("same-origin");
    const parsed = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(parsed).toEqual({ password: "brand-new-pw" });
    expect("token" in parsed).toBe(false); // the one-time token stays server-side
  });

  it("throws ApiClientError(400) for an invalid/expired token (generic)", async () => {
    stubFetch(
      jsonResponse(400, { error: { code: "bad_request", message: "This password reset link is invalid or has expired." } }),
    );
    await expect(
      new AuthClient({ baseUrl: BASE }).resetPassword("brand-new-pw"),
    ).rejects.toMatchObject({ status: 400 });
  });
});
