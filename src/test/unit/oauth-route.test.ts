/**
 * HTTP-boundary tests for the OAuth routes (`@/api/routes/oauth`) — state design
 * §14. These drive the real `buildApp` with a fake `OAuthService` via
 * `app.inject`, so the two trust zones are proven on the wire with no port,
 * socket, or database:
 *   - authorize + disconnect demand a HUMAN session — tenant/user come from the
 *     verified session, a machine API key (no `userId`) is refused 401, and the
 *     provider slug is allowlist-shaped before the service is called.
 *   - the callback is PUBLIC — no auth hook, trusts the query for nothing but
 *     `state`/`code`, and redirects to the return path recovered from the row.
 * The service is faked, so these pin the routes' own logic (shape validation,
 * human-session gating, domain-error → HTTP-envelope translation), not the
 * orchestration that `oauth-service.test.ts` covers.
 */

import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "@/api/app.js";
import { BadRequestError, UnauthorizedError } from "@/api/errors.js";
import type { ApiServer } from "@/api/types.js";
import type { AuthContext, Authenticator } from "@/auth/context.js";
import { OAuthProviderError, OAuthStateInvalidError } from "@/oauth/errors.js";
import type { OAuthService } from "@/oauth/oauth-service.js";
import { inertHumanAuth } from "./human-auth-stubs.js";

/** Credentials the fake composite authenticator recognises on the `/v1/*` scope. */
const SESSION = "session-token"; // → a human session (tenant + user)
const MACHINE = "machine-key"; // → a machine API key (tenant, no user)

/**
 * A composite-shaped authenticator: a session token → a human context (with
 * `userId`), a machine key → an API-key context (no `userId`), anything else
 * rejected — the structural split the real `/v1/*` composite makes.
 */
const authenticator: Authenticator = {
  authenticate: async (credential: string): Promise<AuthContext> => {
    if (credential === SESSION) return { tenantId: "t1", userId: "u1" };
    if (credential === MACHINE) return { tenantId: "t1", apiKeyId: "k1" };
    throw new UnauthorizedError();
  },
};

/** Bearer header helper. */
function bearer(credential: string): { authorization: string } {
  return { authorization: `Bearer ${credential}` };
}

/** Every dependency the OAuth routes never touch faults loudly if reached. */
const nope = async (): Promise<never> => {
  throw new Error("not used");
};

interface Harness {
  app: ApiServer;
  begin: ReturnType<typeof vi.fn>;
  complete: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}

async function makeApp(): Promise<Harness> {
  const begin = vi.fn();
  const complete = vi.fn();
  const disconnect = vi.fn();
  const oauthService = {
    beginAuthorization: begin,
    completeCallback: complete,
    disconnect,
  } as unknown as OAuthService;

  const app = await buildApp({
    logger: pino({ level: "silent" }),
    authenticator,
    // `/v1/*` is guarded by `authenticator`; the session authenticator only guards
    // `/auth/*`, which this suite never drives. The rest of the human-auth
    // dependency set is inert.
    ...inertHumanAuth(),
    oauthService,
    checkDatabase: async () => {},
    rateLimit: { max: 10_000 },
    apiKeyServiceFor: () => ({ create: nope, list: async () => [], revoke: nope }),
    workflowServiceFor: () => ({
      create: nope,
      createVersion: nope,
      activateVersion: nope,
      getWorkflow: nope,
      listVersions: async () => [],
      getActiveVersion: async () => null,
      listWorkflows: async () => ({ items: [], nextCursor: null }),
    }),
    connectionServiceFor: () => ({
      create: nope,
      listMetadata: async () => [],
      listMetadataPage: async () => ({ items: [], nextCursor: null }),
      getMetadata: async () => null,
      updateMetadata: async () => null,
      disable: async () => null,
      delete: async () => false,
      resolveForTool: nope,
    }),
    webhookIngestorFor: () => ({ ingest: nope }),
    webhookSignatureResolverFor: () => ({ resolveForSource: async () => null }),
    runInspectionFor: () => ({
      getRun: async () => null,
      listRuns: async () => ({ items: [], nextCursor: null }),
    }),
  });

  return { app, begin, complete, disconnect };
}

let current: Harness | undefined;

afterEach(async () => {
  if (current !== undefined) {
    await current.app.close();
    current = undefined;
  }
});

describe("POST /v1/oauth/:provider/authorize", () => {
  const authorize = (headers: Record<string, string>, payload: object = {}) =>
    current!.app.inject({ method: "POST", url: "/v1/oauth/github/authorize", headers, payload });

  it("mints an authorization URL for a human session, sealing in the session tenant/user", async () => {
    current = await makeApp();
    current.begin.mockResolvedValue({ authorizationUrl: "https://provider.example/authorize?state=abc" });
    const res = await authorize(bearer(SESSION));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ authorizationUrl: "https://provider.example/authorize?state=abc" });
    expect(current.begin).toHaveBeenCalledWith({ tenantId: "t1", userId: "u1", provider: "github" });
  });

  it("forwards an optional return path and scope override to the service", async () => {
    current = await makeApp();
    current.begin.mockResolvedValue({ authorizationUrl: "https://provider.example/authorize" });
    const res = await authorize(bearer(SESSION), { returnPath: "/connections?tab=github", scopes: ["repo"] });
    expect(res.statusCode).toBe(200);
    expect(current.begin).toHaveBeenCalledWith({
      tenantId: "t1",
      userId: "u1",
      provider: "github",
      returnPath: "/connections?tab=github",
      scopes: ["repo"],
    });
  });

  it("refuses a machine API key with 401, never calling the service", async () => {
    current = await makeApp();
    const res = await authorize(bearer(MACHINE));
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("unauthorized");
    expect(current.begin).not.toHaveBeenCalled();
  });

  it("refuses a missing credential with 401", async () => {
    current = await makeApp();
    const res = await current.app.inject({ method: "POST", url: "/v1/oauth/github/authorize", payload: {} });
    expect(res.statusCode).toBe(401);
    expect(current.begin).not.toHaveBeenCalled();
  });

  it("404s a malformed provider slug, never calling the service", async () => {
    current = await makeApp();
    for (const slug of ["GitHub", "1github"]) {
      const res = await current.app.inject({ method: "POST", url: `/v1/oauth/${slug}/authorize`, headers: bearer(SESSION), payload: {} });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe("not_found");
    }
    expect(current.begin).not.toHaveBeenCalled();
  });

  it("400s an invalid body (empty return path), never calling the service", async () => {
    current = await makeApp();
    const res = await authorize(bearer(SESSION), { returnPath: "" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("bad_request");
    expect(current.begin).not.toHaveBeenCalled();
  });

  it("maps an unknown-provider service error to a non-enumerable 404", async () => {
    current = await makeApp();
    current.begin.mockRejectedValue(new OAuthProviderError("unknown OAuth provider", "unknown_provider"));
    const res = await authorize(bearer(SESSION));
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
  });

  it("maps any other provider rejection to a 400 with no provider text", async () => {
    current = await makeApp();
    current.begin.mockRejectedValue(new OAuthProviderError("the provider rejected the token request", "invalid_grant"));
    const res = await authorize(bearer(SESSION));
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("bad_request");
    expect(res.body).not.toContain("invalid_grant");
  });

  it("passes a service-raised ApiError (unsafe return path) straight through", async () => {
    current = await makeApp();
    current.begin.mockRejectedValue(new BadRequestError("The return path must be relative to this application."));
    const res = await authorize(bearer(SESSION), { returnPath: "/ok" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("bad_request");
  });
});

describe("POST /v1/oauth/connections/:id/disconnect", () => {
  const send = (id: string, headers: Record<string, string>) =>
    current!.app.inject({ method: "POST", url: `/v1/oauth/connections/${id}/disconnect`, headers });

  it("returns 204 and forwards the session tenant + path id to the service", async () => {
    current = await makeApp();
    current.disconnect.mockResolvedValue(true);
    const res = await send("conn-1", bearer(SESSION));
    expect(res.statusCode).toBe(204);
    expect(current.disconnect).toHaveBeenCalledWith({ tenantId: "t1", connectionId: "conn-1" });
  });

  it("returns 404 when the connection is absent from the caller's tenant", async () => {
    current = await makeApp();
    current.disconnect.mockResolvedValue(false);
    const res = await send("missing", bearer(SESSION));
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
  });

  it("refuses a machine API key with 401, never calling the service", async () => {
    current = await makeApp();
    const res = await send("conn-1", bearer(MACHINE));
    expect(res.statusCode).toBe(401);
    expect(current.disconnect).not.toHaveBeenCalled();
  });

  it("400s an over-long connection id before calling the service", async () => {
    current = await makeApp();
    const res = await send("c".repeat(65), bearer(SESSION));
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("bad_request");
    expect(current.disconnect).not.toHaveBeenCalled();
  });
});

describe("GET /oauth/:provider/callback", () => {
  const callback = (query: string) => current!.app.inject({ method: "GET", url: `/oauth/github/callback${query}` });

  it("is public and redirects to the return path recovered from the consumed row", async () => {
    current = await makeApp();
    current.complete.mockResolvedValue({ returnPath: "/connections?tab=github", connectionId: "c1" });
    const res = await callback("?state=opaque&code=the-code");
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/connections?tab=github");
    expect(current.complete).toHaveBeenCalledWith({ provider: "github", state: "opaque", code: "the-code" });
  });

  it("400s when state or code is missing, never calling the service", async () => {
    current = await makeApp();
    for (const query of ["?code=only", "?state=only"]) {
      const res = await callback(query);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("bad_request");
    }
    expect(current.complete).not.toHaveBeenCalled();
  });

  it("maps an invalid/expired/replayed state to an undifferentiated 400", async () => {
    current = await makeApp();
    current.complete.mockRejectedValue(new OAuthStateInvalidError());
    const res = await callback("?state=stale&code=x");
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("bad_request");
  });

  it("maps an unknown provider to a non-enumerable 404", async () => {
    current = await makeApp();
    current.complete.mockRejectedValue(new OAuthProviderError("unknown OAuth provider", "unknown_provider"));
    const res = await callback("?state=s&code=c");
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
  });

  it("maps any other provider rejection to a 400", async () => {
    current = await makeApp();
    current.complete.mockRejectedValue(new OAuthProviderError("rejected", "invalid_grant"));
    const res = await callback("?state=s&code=c");
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("bad_request");
  });
});
