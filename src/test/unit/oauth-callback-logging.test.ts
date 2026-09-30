/**
 * Regression — the public OAuth callback carries `state` and `code` in its URL
 * query, and Fastify's default request logging serialises `req.url` VERBATIM on
 * the "incoming request" line of every request. These tests pin the redaction
 * that keeps those two secrets — and any OAuth-shaped token/verifier/secret
 * param — out of the log, while leaving the path, provider, method, and any
 * unrelated route's query byte-for-byte intact.
 *
 * Two layers, both offline (no port, socket, or database):
 *   - the pure censor `redactSensitiveQuery` — exhaustive and direct;
 *   - the real wiring — the production `createLogger` feeding the real
 *     `buildApp`, captured through a stream, proving the callback's live log
 *     line is redacted on the wire.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "@/api/app.js";
import { UnauthorizedError } from "@/api/errors.js";
import type { ApiServer } from "@/api/types.js";
import type { AuthContext, Authenticator } from "@/auth/context.js";
import { parseEnv } from "@/config/env.js";
import { REDACTED, SENSITIVE_QUERY_KEYS, redactSensitiveQuery } from "@/observability/log-redaction.js";
import { createLogger } from "@/observability/logger.js";
import type { OAuthService } from "@/oauth/oauth-service.js";

import { inertHumanAuth } from "./human-auth-stubs.js";

describe("redactSensitiveQuery", () => {
  it("masks state and code, preserving key names and order", () => {
    expect(redactSensitiveQuery("/oauth/github/callback?state=abc123&code=xyz789")).toBe(
      `/oauth/github/callback?state=${REDACTED}&code=${REDACTED}`,
    );
  });

  it("masks the whole token/verifier/secret family, case-insensitively", () => {
    for (const key of SENSITIVE_QUERY_KEYS) {
      const shouty = key.toUpperCase();
      expect(redactSensitiveQuery(`/x?${shouty}=leak`)).toBe(`/x?${shouty}=${REDACTED}`);
    }
  });

  it("leaves a non-sensitive query byte-for-byte unchanged", () => {
    const url = "/v1/workflows?limit=50&cursor=eyJpZCI6MX0";
    expect(redactSensitiveQuery(url)).toBe(url);
  });

  it("masks only the sensitive pairs within a mixed query", () => {
    expect(redactSensitiveQuery("/cb?provider=github&code=secret&next=%2Fhome")).toBe(
      `/cb?provider=github&code=${REDACTED}&next=%2Fhome`,
    );
  });

  it("returns a query-less URL untouched", () => {
    expect(redactSensitiveQuery("/oauth/github/callback")).toBe("/oauth/github/callback");
  });

  it("masks the value but preserves a trailing fragment", () => {
    expect(redactSensitiveQuery("/cb?code=secret#done")).toBe(`/cb?code=${REDACTED}#done`);
  });

  it("passes non-string input straight through", () => {
    expect(redactSensitiveQuery(undefined)).toBeUndefined();
    expect(redactSensitiveQuery(42)).toBe(42);
  });
});

/** Human-session credential the fake authenticator accepts on `/v1/*`. */
const SESSION = "session-token";

const authenticator: Authenticator = {
  authenticate: async (credential: string): Promise<AuthContext> => {
    if (credential === SESSION) return { tenantId: "t1", userId: "u1" };
    throw new UnauthorizedError();
  },
};

/** Any dependency the callback never reaches faults loudly if touched. */
const nope = async (): Promise<never> => {
  throw new Error("not used");
};

interface Captured {
  app: ApiServer;
  lines: string[];
}

/**
 * Build the REAL app behind the REAL logging factory, capturing every emitted
 * line. `info` level lets the "incoming request" line (which carries req.url)
 * through; the capture stream doubles as the destination that forces the dev
 * pretty-transport off.
 */
async function makeApp(): Promise<Captured> {
  const lines: string[] = [];
  const logger = createLogger(
    parseEnv({ DATABASE_URL: "postgresql://u:p@localhost:5432/ai_workforce_test", LOG_LEVEL: "info" }),
    { service: "test" },
    {
      write(chunk: string): void {
        lines.push(chunk);
      },
    },
  );

  const oauthService = {
    beginAuthorization: vi.fn(),
    completeCallback: vi.fn().mockResolvedValue({ returnPath: "/connections", connectionId: "c1" }),
    disconnect: vi.fn(),
  } as unknown as OAuthService;

  const app = await buildApp({
    logger,
    authenticator,
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

  return { app, lines };
}

let current: Captured | undefined;

afterEach(async () => {
  if (current !== undefined) {
    await current.app.close();
    current = undefined;
  }
});

describe("GET /oauth/:provider/callback request logging", () => {
  // Distinctive sentinels: if either survives into the captured log, the secret
  // leaked. Shaped so they cannot collide with any framework log token.
  const STATE = "SENTINEL_state_5b1c9e_do_not_log";
  const CODE = "SENTINEL_code_a72f40_do_not_log";

  it("redacts state and code from the request log, keeping path, provider, and method", async () => {
    current = await makeApp();
    const res = await current.app.inject({
      method: "GET",
      url: `/oauth/github/callback?state=${STATE}&code=${CODE}`,
    });
    expect(res.statusCode).toBe(302);

    const log = current.lines.join("");
    expect(log).not.toContain(STATE);
    expect(log).not.toContain(CODE);
    expect(log).toContain(`/oauth/github/callback?state=${REDACTED}&code=${REDACTED}`);
    expect(log).toContain('"method":"GET"');
    // Redaction did not silence request logging.
    expect(log).toContain("incoming request");
  });

  it("leaves an unrelated route's non-sensitive query intact", async () => {
    current = await makeApp();
    // Fastify logs the incoming request (with req.url) before routing, so this
    // holds whether or not `/healthz` exists — and `probe` is not sensitive.
    await current.app.inject({ method: "GET", url: "/healthz?probe=SENTINEL_probe_keep_me" });

    expect(current.lines.join("")).toContain("probe=SENTINEL_probe_keep_me");
  });
});
