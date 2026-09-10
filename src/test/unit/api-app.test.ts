/**
 * HTTP-boundary tests for the assembled API.
 *
 * These drive the real `buildApp` with fake dependencies via `app.inject`, so
 * the whole request pipeline — routing, the auth `onRequest` hook, the error
 * handler, the health route, rate-limit wiring — is exercised with no port, no
 * socket and no database. The fakes are behaviourally faithful (a shared
 * in-memory backend that both authenticates and manages keys) so a full key
 * lifecycle can be tested end to end.
 *
 * What is proven here:
 *   - `/healthz` reports 200 when the DB check passes and 503 when it fails,
 *     and leaks no connection detail either way
 *   - every authentication failure is a 401 in the one error envelope
 *   - the created key's plaintext is returned exactly once and never logged
 *   - a revoked key stops authenticating
 *   - tenant A cannot see or revoke tenant B's keys through the routes
 *   - unknown routes and errors all use the same `{ error: {...} }` envelope
 */

import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "@/api/app.js";
import { UnauthorizedError } from "@/api/errors.js";
import type { ApiServer } from "@/api/types.js";
import type { AuthContext, Authenticator } from "@/auth/context.js";
import { generateApiKey } from "@/auth/api-key.js";
import { newId } from "@/domain/ids.js";
import type {
  ApiKeySummary,
  ApiKeyService,
  CreatedApiKey,
} from "@/repositories/api-key-repository.js";

interface StoredKey {
  id: string;
  tenantId: string;
  name: string;
  prefix: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

/**
 * A single in-memory backend that plays both roles the app needs: it
 * authenticates presented credentials and it manages keys per tenant. Sharing
 * state between the two is what lets a created key be authenticated, and a
 * revoked key be rejected, in the same test.
 */
class FakeBackend {
  private readonly keys: StoredKey[] = [];
  /** plaintext → the context it resolves to. */
  private readonly credentials = new Map<string, AuthContext>();

  readonly authenticator: Authenticator = {
    authenticate: async (credential: string): Promise<AuthContext> => {
      const context = this.credentials.get(credential);
      if (context === undefined) throw new UnauthorizedError();
      const row = this.keys.find((k) => k.id === context.apiKeyId);
      if (row === undefined || row.revokedAt !== null)
        throw new UnauthorizedError();
      return context;
    },
  };

  /** Build the tenant-scoped service the routes are handed per request. */
  serviceFor = (auth: AuthContext): ApiKeyService => {
    const tenantId = auth.tenantId;
    const summary = (k: StoredKey): ApiKeySummary => ({
      id: k.id,
      name: k.name,
      prefix: k.prefix,
      createdAt: k.createdAt,
      lastUsedAt: k.lastUsedAt,
      revokedAt: k.revokedAt,
    });

    return {
      create: async (name: string): Promise<CreatedApiKey> => {
        const generated = generateApiKey();
        const row: StoredKey = {
          id: newId(),
          tenantId,
          name,
          prefix: generated.prefix,
          createdAt: new Date(),
          lastUsedAt: null,
          revokedAt: null,
        };
        this.keys.push(row);
        this.credentials.set(generated.plaintext, {
          tenantId,
          apiKeyId: row.id,
        });
        return {
          id: row.id,
          name: row.name,
          prefix: row.prefix,
          createdAt: row.createdAt,
          plaintext: generated.plaintext,
        };
      },
      list: async (): Promise<ApiKeySummary[]> =>
        this.keys.filter((k) => k.tenantId === tenantId).map(summary),
      revoke: async (id: string): Promise<void> => {
        // Tenant-scoped: only this tenant's rows are even visible.
        const row = this.keys.find(
          (k) => k.id === id && k.tenantId === tenantId,
        );
        if (row === undefined) {
          const { NotFoundError } = await import("@/api/errors.js");
          throw new NotFoundError("API key not found");
        }
        row.revokedAt = new Date();
      },
    };
  };
}

/** Capturing pino logger: every serialised line is pushed to `lines`. */
function captureLogger(): { logger: pino.Logger; lines: string[] } {
  const lines: string[] = [];
  const logger = pino(
    { level: "trace" },
    { write: (chunk: string) => void lines.push(chunk) },
  );
  return { logger, lines };
}

interface Harness {
  app: ApiServer;
  lines: string[];
  backend: FakeBackend;
  dbHealthy: { value: boolean };
}

async function makeApp(): Promise<Harness> {
  const { logger, lines } = captureLogger();
  const backend = new FakeBackend();
  const dbHealthy = { value: true };

  const app = await buildApp({
    logger,
    authenticator: backend.authenticator,
    checkDatabase: async () => {
      if (!dbHealthy.value)
        throw new Error("connection refused to 10.0.0.9:5432");
    },
    apiKeyServiceFor: backend.serviceFor,
    workflowServiceFor: () => ({
      create: async () => {
        throw new Error("not used");
      },
      createVersion: async () => {
        throw new Error("not used");
      },
      activateVersion: async () => {
        throw new Error("not used");
      },
      getWorkflow: async () => {
        throw new Error("not used");
      },
      listVersions: async () => [],
      getActiveVersion: async () => null,
      listWorkflows: async () => ({ items: [], nextCursor: null }),
    }),
    connectionServiceFor: () => ({
      create: async () => {
        throw new Error("not used");
      },
      listMetadata: async () => [],
      listMetadataPage: async () => ({ items: [], nextCursor: null }),
      getMetadata: async () => null,
      updateMetadata: async () => null,
      disable: async () => null,
      delete: async () => false,
      resolveForTool: async () => {
        throw new Error("not used");
      },
    }),
    // Not exercised here; the webhook route has its own suite. A no-op ingestor
    // keeps buildApp's dependency satisfied.
    webhookIngestorFor: () => ({
      ingest: async () => ({
        eventId: newId(),
        runId: null,
        duplicate: false,
        workflowConfigured: false,
      }),
    }),
    // Minimal run-inspection reader factory for the routes that expect it.
    runInspectionFor: () => ({
      getRun: async () => null,
      listRuns: async () => ({ items: [], nextCursor: null }),
    }),
  });

  return { app, lines, backend, dbHealthy };
}

/** Bearer header helper. */
function bearer(key: string): { authorization: string } {
  return { authorization: `Bearer ${key}` };
}

let current: Harness | undefined;

afterEach(async () => {
  if (current !== undefined) {
    await current.app.close();
    current = undefined;
  }
});

/** Mint a working credential for a tenant, the way the out-of-band CLI would. */
async function bootstrapKey(
  backend: FakeBackend,
  tenantId: string,
): Promise<string> {
  const created = await backend
    .serviceFor({ tenantId, apiKeyId: "bootstrap" })
    .create("bootstrap");
  return created.plaintext;
}

describe("GET /healthz", () => {
  it("reports 200 and ok when the database check passes", async () => {
    current = await makeApp();
    const res = await current.app.inject({ method: "GET", url: "/healthz" });

    expect(res.statusCode).toBe(200);
    expect(res.headers).toMatchObject({
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
      "permissions-policy": "geolocation=(), microphone=(), camera=()",
    });
    expect(res.json()).toEqual({
      status: "ok",
      checks: { process: "ok", database: "ok" },
      uptimeSeconds: expect.any(Number),
    });
  });

  it("reports 503 and degraded when the database check fails", async () => {
    current = await makeApp();
    current.dbHealthy.value = false;

    const res = await current.app.inject({ method: "GET", url: "/healthz" });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({
      status: "degraded",
      checks: { process: "ok", database: "down" },
    });
  });

  it("leaks no connection detail even when the database is down", async () => {
    current = await makeApp();
    current.dbHealthy.value = false;

    const res = await current.app.inject({ method: "GET", url: "/healthz" });
    const body = res.body;

    expect(body).not.toContain("5432");
    expect(body).not.toContain("connection refused");
    expect(body).not.toContain("10.0.0.9");
  });

  it("requires no credential", async () => {
    current = await makeApp();
    const res = await current.app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
  });
});

describe("authentication failures", () => {
  it("rejects a missing Authorization header with 401", async () => {
    current = await makeApp();
    const res = await current.app.inject({
      method: "GET",
      url: "/v1/api-keys",
    });

    expect(res.statusCode).toBe(401);
    expect(res.headers).toMatchObject({
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
      "permissions-policy": "geolocation=(), microphone=(), camera=()",
    });
    expect(res.json()).toEqual({
      error: {
        code: "unauthorized",
        message: expect.any(String),
        requestId: expect.any(String),
      },
    });
  });

  it("rejects a non-Bearer Authorization header with 401", async () => {
    current = await makeApp();
    const res = await current.app.inject({
      method: "GET",
      url: "/v1/api-keys",
      headers: { authorization: "Basic abc123" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects an empty Bearer credential with 401", async () => {
    current = await makeApp();
    const res = await current.app.inject({
      method: "GET",
      url: "/v1/api-keys",
      headers: { authorization: "Bearer " },
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects an unknown credential with 401", async () => {
    current = await makeApp();
    const res = await current.app.inject({
      method: "GET",
      url: "/v1/api-keys",
      headers: bearer(generateApiKey().plaintext),
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("API-key lifecycle", () => {
  it("creates a key, returning the plaintext exactly once", async () => {
    current = await makeApp();
    const auth = await bootstrapKey(current.backend, "tenant-a");

    const created = await current.app.inject({
      method: "POST",
      url: "/v1/api-keys",
      headers: bearer(auth),
      payload: { name: "CI" },
    });

    expect(created.statusCode).toBe(201);
    const body = created.json();
    expect(body).toMatchObject({
      name: "CI",
      key: expect.stringMatching(/^awk_/),
      warning: expect.any(String),
    });
    const issued: string = body.key;

    // The plaintext is nowhere in the listing — only metadata.
    const listed = await current.app.inject({
      method: "GET",
      url: "/v1/api-keys",
      headers: bearer(auth),
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.body).not.toContain(issued);
    for (const summary of listed.json().apiKeys) {
      expect(summary).not.toHaveProperty("key");
      expect(summary).not.toHaveProperty("keyHash");
      expect(summary).not.toHaveProperty("plaintext");
    }
  });

  it("rejects a create with an empty name as 400 in the envelope", async () => {
    current = await makeApp();
    const auth = await bootstrapKey(current.backend, "tenant-a");

    const res = await current.app.inject({
      method: "POST",
      url: "/v1/api-keys",
      headers: bearer(auth),
      payload: { name: "   " },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("bad_request");
  });

  it("revokes a key so it can no longer authenticate", async () => {
    current = await makeApp();
    const auth = await bootstrapKey(current.backend, "tenant-a");

    const created = await current.app.inject({
      method: "POST",
      url: "/v1/api-keys",
      headers: bearer(auth),
      payload: { name: "to-be-revoked" },
    });
    const { id, key } = created.json();

    // The freshly created key authenticates.
    const before = await current.app.inject({
      method: "GET",
      url: "/v1/api-keys",
      headers: bearer(key),
    });
    expect(before.statusCode).toBe(200);

    const revoked = await current.app.inject({
      method: "POST",
      url: `/v1/api-keys/${id}/revoke`,
      headers: bearer(auth),
    });
    expect(revoked.statusCode).toBe(204);

    // The same key is now refused.
    const after = await current.app.inject({
      method: "GET",
      url: "/v1/api-keys",
      headers: bearer(key),
    });
    expect(after.statusCode).toBe(401);
  });

  it("never logs the plaintext key", async () => {
    current = await makeApp();
    const auth = await bootstrapKey(current.backend, "tenant-a");

    const created = await current.app.inject({
      method: "POST",
      url: "/v1/api-keys",
      headers: bearer(auth),
      payload: { name: "secret-check" },
    });
    const issued: string = created.json().key;

    // Provoke more log traffic: a successful list and a failed auth.
    await current.app.inject({
      method: "GET",
      url: "/v1/api-keys",
      headers: bearer(auth),
    });
    await current.app.inject({
      method: "GET",
      url: "/v1/api-keys",
      headers: bearer(issued),
    });

    const allLogs = current.lines.join("\n");
    expect(allLogs.length).toBeGreaterThan(0);
    expect(allLogs).not.toContain(issued);
    // Nor the secret half on its own.
    expect(allLogs).not.toContain(issued.slice("awk_".length));
  });
});

describe("tenant isolation at the route boundary", () => {
  it("does not show tenant A the keys of tenant B", async () => {
    current = await makeApp();
    const authA = await bootstrapKey(current.backend, "tenant-a");
    const authB = await bootstrapKey(current.backend, "tenant-b");

    await current.app.inject({
      method: "POST",
      url: "/v1/api-keys",
      headers: bearer(authB),
      payload: { name: "tenant-b-only" },
    });

    const listA = await current.app.inject({
      method: "GET",
      url: "/v1/api-keys",
      headers: bearer(authA),
    });
    const names = listA.json().apiKeys.map((k: ApiKeySummary) => k.name);
    expect(names).not.toContain("tenant-b-only");
  });

  it("gives tenant A a 404 when revoking tenant B a key id", async () => {
    current = await makeApp();
    const authA = await bootstrapKey(current.backend, "tenant-a");
    const authB = await bootstrapKey(current.backend, "tenant-b");

    const bKey = await current.app.inject({
      method: "POST",
      url: "/v1/api-keys",
      headers: bearer(authB),
      payload: { name: "b-key" },
    });
    const bId = bKey.json().id;

    const res = await current.app.inject({
      method: "POST",
      url: `/v1/api-keys/${bId}/revoke`,
      headers: bearer(authA),
    });

    // Indistinguishable from a genuinely missing key: B's existence is not leaked.
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
  });
});

describe("error envelope", () => {
  it("returns the standard envelope with a request id for an unknown route", async () => {
    current = await makeApp();
    const auth = await bootstrapKey(current.backend, "tenant-a");

    const res = await current.app.inject({
      method: "GET",
      url: "/v1/does-not-exist",
      headers: bearer(auth),
    });

    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.error.code).toBe("not_found");
    expect(typeof body.error.requestId).toBe("string");
    expect(body.error.requestId.length).toBeGreaterThan(0);
  });

  it("correlates the error response request id with the request log", async () => {
    current = await makeApp();
    const res = await current.app.inject({
      method: "GET",
      url: "/v1/api-keys",
    });

    const requestId: string = res.json().error.requestId;
    expect(requestId.length).toBeGreaterThan(0);
    // The same id an operator would search logs by appears on the log lines for
    // this request, so a caller can quote it and be found.
    const logged = current.lines.some((line) => line.includes(requestId));
    expect(logged).toBe(true);
  });

  it("gives each request a distinct id", async () => {
    current = await makeApp();
    const a = await current.app.inject({ method: "GET", url: "/v1/api-keys" });
    const b = await current.app.inject({ method: "GET", url: "/v1/api-keys" });
    expect(a.json().error.requestId).not.toBe(b.json().error.requestId);
  });
});
