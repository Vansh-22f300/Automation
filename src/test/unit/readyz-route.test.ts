/**
 * Tests for `GET /readyz`.
 *
 * Mirrors the structure of the /healthz block in api-app.test.ts but lives in
 * its own file so the readiness contract — a binary DB check that the load
 * balancer / orchestrator can act on — is clearly separated from the
 * process-liveness contract. The /healthz test file asserts "always 200, no
 * dependency check"; this file asserts "200 only when the DB probe resolves,
 * 503 otherwise, and never leak connection detail."
 */

import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "@/api/app.js";
import type { ApiServer } from "@/api/types.js";
import type { AuthContext, Authenticator } from "@/auth/context.js";

/** Capturing pino logger; tests do not assert log content here, only responses. */
function captureLogger(): pino.Logger {
  return pino({ level: "silent" });
}

interface Harness {
  app: ApiServer;
  dbHealthy: { value: boolean };
  checkCalls: { count: number };
}

async function makeApp(): Promise<Harness> {
  const dbHealthy = { value: true };
  const checkCalls = { count: 0 };

  // Minimal authenticator — /readyz never reaches it, but buildApp's
  // AppDependencies type requires it.
  const authenticator: Authenticator = {
    authenticate: async (_credential: string): Promise<AuthContext> => {
      throw new Error("not reached by /readyz");
    },
  };

  const app = await buildApp({
    logger: captureLogger(),
    authenticator,
    checkDatabase: async () => {
      checkCalls.count += 1;
      if (!dbHealthy.value) {
        throw new Error("connection refused to 10.0.0.9:5432");
      }
    },
    apiKeyServiceFor: () => {
      throw new Error("not reached by /readyz");
    },
    workflowServiceFor: () => {
      throw new Error("not reached by /readyz");
    },
    connectionServiceFor: () => {
      throw new Error("not reached by /readyz");
    },
    webhookIngestorFor: () => ({
      ingest: async () => {
        throw new Error("not reached by /readyz");
      },
    }),
    webhookSignatureResolverFor: () => ({
      resolveForSource: async () => null,
    }),
    runInspectionFor: () => ({
      getRun: async () => null,
      listRuns: async () => ({ items: [], nextCursor: null }),
    }),
  });

  return { app, dbHealthy, checkCalls };
}

let current: Harness | undefined;

afterEach(async () => {
  if (current !== undefined) {
    await current.app.close();
    current = undefined;
  }
});

describe("GET /readyz", () => {
  it("reports 200 and ready when the database check passes", async () => {
    current = await makeApp();
    const res = await current.app.inject({ method: "GET", url: "/readyz" });

    expect(res.statusCode).toBe(200);
    expect(res.headers).toMatchObject({
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
      "permissions-policy": "geolocation=(), microphone=(), camera=()",
    });
    expect(res.json()).toEqual({
      status: "ready",
      checks: { process: "ok", database: "ok" },
      uptimeSeconds: expect.any(Number),
    });
    expect(current.checkCalls.count).toBe(1);
  });

  it("reports 503 and not_ready when the database check fails", async () => {
    current = await makeApp();
    current.dbHealthy.value = false;

    const res = await current.app.inject({ method: "GET", url: "/readyz" });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({
      status: "not_ready",
      checks: { process: "ok", database: "down" },
    });
    expect(current.checkCalls.count).toBe(1);
  });

  it("leaks no connection detail when the database is down", async () => {
    current = await makeApp();
    current.dbHealthy.value = false;

    const res = await current.app.inject({ method: "GET", url: "/readyz" });
    const body = res.body;

    // The injected check would throw with these substrings. None of them
    // must ever appear in the response body — only "down" is allowed.
    expect(body).not.toContain("5432");
    expect(body).not.toContain("connection refused");
    expect(body).not.toContain("10.0.0.9");
    expect(body).not.toContain("Error");
    expect(body).not.toContain("error");
  });

  it("requires no credential", async () => {
    current = await makeApp();
    // No Authorization header — /readyz must be public like /healthz.
    const res = await current.app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(200);
  });

  it("does not depend on worker state (no worker section in the body)", async () => {
    // The worker runs in a different process; this process has no way to
    // know whether it is up. /readyz must therefore report only API
    // readiness — coupling the two would make a healthy API look unready
    // just because the worker is down.
    current = await makeApp();
    const res = await current.app.inject({ method: "GET", url: "/readyz" });
    const body = res.json();
    expect(body).not.toHaveProperty("worker");
    expect(body).not.toHaveProperty("workers");
    expect(body.checks).not.toHaveProperty("worker");
  });
});
