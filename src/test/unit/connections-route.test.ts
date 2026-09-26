import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "@/api/app.js";
import { inertHumanAuth } from "./human-auth-stubs.js";
import { UnauthorizedError } from "@/api/errors.js";
import type { ApiServer } from "@/api/types.js";
import type { AuthContext, Authenticator } from "@/auth/context.js";
import type { ConnectionListPage } from "@/repositories/connection-repository.js";

const KEY_T1 = "key-1";
const KEY_T2 = "key-2";

const authenticator: Authenticator = {
  authenticate: async (credential: string): Promise<AuthContext> => {
    if (credential === KEY_T1) return { tenantId: "tenant-1", apiKeyId: "k1" };
    if (credential === KEY_T2) return { tenantId: "tenant-2", apiKeyId: "k2" };
    throw new UnauthorizedError();
  },
};

class RecordingConnectionService {
  readonly calls: Array<{ tenantId: string; limit?: number; cursor?: string }> =
    [];

  constructor(private readonly tenantId: string) {}

  async listMetadataPage(
    options: { readonly limit?: number; readonly cursor?: string } = {},
  ): Promise<ConnectionListPage> {
    this.calls.push({ tenantId: this.tenantId, ...options });
    if (this.tenantId === "tenant-2") return { items: [], nextCursor: null };
    if (options.cursor === "cursor-1") {
      return {
        items: [
          {
            id: "conn-3",
            provider: "slack",
            name: "Ops Slack",
            status: "active",
            metadata: { workspace: "ops" },
            createdAt: new Date("2026-01-03T00:00:00.000Z"),
            updatedAt: new Date("2026-01-03T00:00:00.000Z"),
            lastUsedAt: null,
          },
        ],
        nextCursor: null,
      };
    }
    return {
      items: [
        {
          id: "conn-2",
          provider: "github",
          name: "CI",
          status: "disabled",
          metadata: { org: "acme" },
          createdAt: new Date("2026-01-02T00:00:00.000Z"),
          updatedAt: new Date("2026-01-02T00:00:00.000Z"),
          lastUsedAt: new Date("2026-01-03T00:00:00.000Z"),
        },
        {
          id: "conn-1",
          provider: "slack",
          name: "Primary",
          status: "active",
          metadata: { workspace: "primary" },
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          updatedAt: new Date("2026-01-01T00:00:00.000Z"),
          lastUsedAt: null,
        },
      ],
      nextCursor: "cursor-1",
    };
  }

  async listMetadata(limit?: number): Promise<never[]> {
    void limit;
    return [];
  }

  async create(): Promise<never> {
    throw new Error("not used");
  }
  async getMetadata(): Promise<null> {
    return null;
  }
  async updateMetadata(): Promise<null> {
    return null;
  }
  async disable(): Promise<null> {
    return null;
  }
  async delete(): Promise<boolean> {
    return false;
  }
  async resolveForTool(): Promise<never> {
    throw new Error("not used");
  }
}

function silentLogger(): pino.Logger {
  return pino({ level: "silent" });
}

interface Harness {
  app: ApiServer;
}

async function makeApp(): Promise<Harness> {
  const app = await buildApp({
    logger: silentLogger(),
    ...inertHumanAuth(),
    authenticator,
    checkDatabase: async () => undefined,
    apiKeyServiceFor: () => ({
      create: async () => {
        throw new Error("not used");
      },
      list: async () => [],
      revoke: async () => {
        throw new Error("not used");
      },
    }),
    workflowServiceFor: () => ({
      listWorkflows: async () => ({ items: [], nextCursor: null }),
    }),
    connectionServiceFor: (auth) =>
      new RecordingConnectionService(auth.tenantId),
    webhookIngestorFor: () => ({
      ingest: async () => ({
        eventId: "ev-1",
        runId: null,
        duplicate: false,
        workflowConfigured: false,
      }),
    }),
    // Not exercised here; the webhook route has its own suite.
    webhookSignatureResolverFor: () => ({
      resolveForSource: async () => null,
    }),
    runInspectionFor: () => ({
      getRun: async () => null,
      listRuns: async () => ({ items: [], nextCursor: null }),
    }),
  });
  return { app };
}

const bearer = (key: string) => ({ authorization: `Bearer ${key}` });

let current: Harness | undefined;
afterEach(async () => {
  if (current !== undefined) {
    await current.app.close();
    current = undefined;
  }
});

describe("GET /v1/connections", () => {
  it("rejects a missing API key with 401", async () => {
    current = await makeApp();
    const res = await current.app.inject({
      method: "GET",
      url: "/v1/connections",
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns the tenant connection list with safe metadata", async () => {
    current = await makeApp();
    const res = await current.app.inject({
      method: "GET",
      url: "/v1/connections",
      headers: bearer(KEY_T1),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      items: expect.arrayContaining([
        expect.objectContaining({
          id: "conn-2",
          provider: "github",
          name: "CI",
          status: "disabled",
        }),
      ]),
      page: { limit: 20, nextCursor: "cursor-1" },
    });
    expect(JSON.stringify(res.json())).not.toContain("encryptedCredentials");
    expect(JSON.stringify(res.json())).not.toContain("token");
  });

  it("returns an empty list when there are no connections", async () => {
    current = await makeApp();
    const res = await current.app.inject({
      method: "GET",
      url: "/v1/connections",
      headers: bearer(KEY_T2),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      items: [],
      page: { limit: 20, nextCursor: null },
    });
  });

  it("rejects a malformed limit with 400", async () => {
    current = await makeApp();
    const res = await current.app.inject({
      method: "GET",
      url: "/v1/connections?limit=101",
      headers: bearer(KEY_T1),
    });
    expect(res.statusCode).toBe(400);
  });

  it("passes the cursor through for pagination", async () => {
    current = await makeApp();
    const res = await current.app.inject({
      method: "GET",
      url: "/v1/connections?cursor=cursor-1",
      headers: bearer(KEY_T1),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().page.nextCursor).toBeNull();
  });
});
