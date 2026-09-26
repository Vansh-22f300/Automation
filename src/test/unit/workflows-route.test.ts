import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "@/api/app.js";
import { inertHumanAuth } from "./human-auth-stubs.js";
import { UnauthorizedError } from "@/api/errors.js";
import type { ApiServer } from "@/api/types.js";
import type { AuthContext, Authenticator } from "@/auth/context.js";
import type { WorkflowListPage } from "@/repositories/workflow-repository.js";

const KEY_T1 = "key-1";
const KEY_T2 = "key-2";

const authenticator: Authenticator = {
  authenticate: async (credential: string): Promise<AuthContext> => {
    if (credential === KEY_T1) return { tenantId: "tenant-1", apiKeyId: "k1" };
    if (credential === KEY_T2) return { tenantId: "tenant-2", apiKeyId: "k2" };
    throw new UnauthorizedError();
  },
};

class RecordingWorkflowService {
  readonly calls: Array<{ tenantId: string; limit?: number; cursor?: string }> =
    [];

  constructor(private readonly tenantId: string) {}

  async listWorkflows(
    limit?: number,
    cursor?: string,
  ): Promise<WorkflowListPage> {
    this.calls.push({
      tenantId: this.tenantId,
      ...(limit !== undefined ? { limit } : {}),
      ...(cursor !== undefined ? { cursor } : {}),
    });
    if (this.tenantId === "tenant-2") return { items: [], nextCursor: null };
    if (cursor === "cursor-1") {
      return {
        items: [
          {
            id: "wf-3",
            name: "Workflow C",
            status: "draft",
            createdAt: "2026-01-03T00:00:00.000Z",
            updatedAt: "2026-01-03T00:00:00.000Z",
            activeVersion: null,
          },
        ],
        nextCursor: null,
      };
    }
    return {
      items: [
        {
          id: "wf-2",
          name: "Workflow B",
          status: "active",
          createdAt: "2026-01-02T00:00:00.000Z",
          updatedAt: "2026-01-02T00:00:00.000Z",
          activeVersion: { id: "ver-2", version: 2, triggerType: "webhook" },
        },
        {
          id: "wf-1",
          name: "Workflow A",
          status: "draft",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          activeVersion: null,
        },
      ],
      nextCursor: "cursor-1",
    };
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
    workflowServiceFor: (auth) => new RecordingWorkflowService(auth.tenantId),
    connectionServiceFor: () => ({
      listMetadata: async () => [],
      listMetadataPage: async () => ({ items: [], nextCursor: null }),
      create: async () => {
        throw new Error("not used");
      },
      getMetadata: async () => null,
      updateMetadata: async () => null,
      disable: async () => null,
      delete: async () => false,
      resolveForTool: async () => {
        throw new Error("not used");
      },
    }),
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

describe("GET /v1/workflows", () => {
  it("rejects a missing API key with 401", async () => {
    current = await makeApp();
    const res = await current.app.inject({
      method: "GET",
      url: "/v1/workflows",
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns the tenant workflow list with pagination metadata", async () => {
    current = await makeApp();
    const res = await current.app.inject({
      method: "GET",
      url: "/v1/workflows",
      headers: bearer(KEY_T1),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      items: expect.arrayContaining([
        expect.objectContaining({
          id: "wf-2",
          name: "Workflow B",
          status: "active",
        }),
      ]),
      page: { limit: 20, nextCursor: "cursor-1" },
    });
  });

  it("returns an empty list when there are no workflows", async () => {
    current = await makeApp();
    const res = await current.app.inject({
      method: "GET",
      url: "/v1/workflows",
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
      url: "/v1/workflows?limit=101",
      headers: bearer(KEY_T1),
    });
    expect(res.statusCode).toBe(400);
  });

  it("passes the cursor through for pagination", async () => {
    current = await makeApp();
    const res = await current.app.inject({
      method: "GET",
      url: "/v1/workflows?cursor=cursor-1",
      headers: bearer(KEY_T1),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().page.nextCursor).toBeNull();
  });
});
