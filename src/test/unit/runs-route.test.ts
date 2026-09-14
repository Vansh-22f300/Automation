/**
 * HTTP-boundary tests for GET /v1/runs/:runId, via the real `buildApp` + inject.
 *
 * A fake `RunInspectionReader` stands in for the repository, so the whole pipeline
 * — auth hook, tenant derivation, 404-on-null, envelope — is exercised with no
 * database. The fixture the reader returns is produced by the SAME pure assembler
 * the CLI uses, so "the endpoint returns the shared DTO" and "no secret/internal
 * field leaks" are both proven against the real shaping, not a hand-written stub.
 */

import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "@/api/app.js";
import { UnauthorizedError } from "@/api/errors.js";
import type { ApiServer } from "@/api/types.js";
import type { AuthContext, Authenticator } from "@/auth/context.js";
import type {
  Event,
  Job,
  Workflow,
  WorkflowRun,
  WorkflowStepRun,
  WorkflowVersion,
} from "@/db/schema.js";
import { assembleRunInspection } from "@/domain/run-inspection.js";
import type { RunInspection } from "@/domain/run-inspection.js";
import type {
  RunInspectionOptions,
  RunInspectionReader,
  RunListReader,
} from "@/repositories/run-inspection-repository.js";

const KEY_T1 = "key-1";
const KEY_T2 = "key-2";
const OWN_RUN = "run-own";

const authenticator: Authenticator = {
  authenticate: async (credential: string): Promise<AuthContext> => {
    if (credential === KEY_T1) return { tenantId: "tenant-1", apiKeyId: "k1" };
    if (credential === KEY_T2) return { tenantId: "tenant-2", apiKeyId: "k2" };
    throw new UnauthorizedError();
  },
};

const T = (ms: number): Date => new Date(ms);

/** Build the fixture through the real assembler, with a secret planted in context. */
function fixture(): RunInspection {
  const run = {
    id: OWN_RUN,
    tenantId: "tenant-1",
    workflowId: "wf-1",
    workflowVersionId: "ver-1",
    eventId: "ev-1",
    status: "succeeded",
    currentStepKey: "a",
    context: { steps: { a: { token: "planted-secret-value" } } },
    error: null,
    createdAt: T(1_000),
    startedAt: T(1_100),
    finishedAt: T(1_200),
  } as WorkflowRun;
  const workflow = {
    id: "wf-1",
    tenantId: "tenant-1",
    name: "WF",
    status: "active",
    createdAt: T(0),
    updatedAt: T(0),
  } as Workflow;
  const version = {
    id: "ver-1",
    tenantId: "tenant-1",
    workflowId: "wf-1",
    version: 1,
    definition: {},
    triggerType: "webhook",
    triggerConfig: { source: "s", secret_ref: "trigger-secret-ref" },
    isActive: true,
    createdAt: T(0),
  } as WorkflowVersion;
  const event = {
    id: "ev-1",
    tenantId: "tenant-1",
    source: "s",
    dedupeKey: "d",
    payload: { ok: 1 },
    receivedAt: T(500),
  } as Event;
  const step = {
    id: "sr-1",
    tenantId: "tenant-1",
    runId: OWN_RUN,
    stepKey: "a",
    stepType: "noop",
    attempt: 0,
    status: "succeeded",
    input: null,
    output: { ok: true },
    error: null,
    startedAt: T(1_100),
    finishedAt: T(1_150),
    durationMs: 50,
  } as WorkflowStepRun;
  const job = {
    id: "job-1",
    tenantId: "tenant-1",
    runId: OWN_RUN,
    stepKey: "a",
    attempt: 0,
    retryCount: 0,
    maxAttempts: 5,
    status: "running",
    runAt: T(1_000),
    lockedBy: "worker-secret-id",
    leaseExpiresAt: T(9_000),
    lastError: null,
    createdAt: T(1_000),
    updatedAt: T(1_000),
  } as Job;
  return assembleRunInspection(
    { run, workflow, version, event, steps: [step], jobs: [job], llmUsage: [] },
    { detail: false, now: 2_000 },
  );
}

const FIXTURE = fixture();

const readerFor = (auth: AuthContext): RunInspectionReader & RunListReader => ({
  getRun: async (
    runId: string,
    _options?: RunInspectionOptions,
  ): Promise<RunInspection | null> =>
    auth.tenantId === "tenant-1" && runId === OWN_RUN ? FIXTURE : null,
  listRuns: async (options = {}) => {
    if (auth.tenantId === "tenant-2") return { items: [], nextCursor: null };
    if (options.cursor === "cursor-1") {
      return {
        items: [
          {
            id: "run-3",
            workflowId: "wf-1",
            workflowName: "WF",
            workflowVersionId: "ver-1",
            status: "running",
            currentStepKey: "b",
            createdAt: "2026-01-03T00:00:00.000Z",
            startedAt: "2026-01-03T00:00:01.000Z",
            finishedAt: null,
            error: null,
          },
        ],
        nextCursor: null,
      };
    }
    return {
      items: [
        {
          id: "run-2",
          workflowId: "wf-1",
          workflowName: "WF",
          workflowVersionId: "ver-1",
          status: "succeeded",
          currentStepKey: null,
          createdAt: "2026-01-02T00:00:00.000Z",
          startedAt: "2026-01-02T00:00:01.000Z",
          finishedAt: "2026-01-02T00:05:00.000Z",
          error: null,
        },
        {
          id: "run-1",
          workflowId: "wf-1",
          workflowName: "WF",
          workflowVersionId: "ver-1",
          status: "failed",
          currentStepKey: "a",
          createdAt: "2026-01-01T00:00:00.000Z",
          startedAt: "2026-01-01T00:00:01.000Z",
          finishedAt: "2026-01-01T00:01:00.000Z",
          error: { code: "bad_input", message: "bad input", retryable: false },
        },
      ],
      nextCursor: "cursor-1",
    };
  },
});

function silentLogger(): pino.Logger {
  return pino({ level: "silent" });
}

async function makeApp(): Promise<ApiServer> {
  return buildApp({
    logger: silentLogger(),
    authenticator,
    checkDatabase: async () => undefined,
    apiKeyServiceFor: () => {
      throw new Error("not used");
    },
    workflowServiceFor: () => {
      throw new Error("not used");
    },
    connectionServiceFor: () => {
      throw new Error("not used");
    },
    webhookIngestorFor: () => {
      throw new Error("not used");
    },
    webhookSignatureResolverFor: () => {
      throw new Error("not used");
    },
    runInspectionFor: readerFor,
  });
}

const bearer = (key: string) => ({ authorization: `Bearer ${key}` });

let app: ApiServer | undefined;
afterEach(async () => {
  if (app !== undefined) {
    await app.close();
    app = undefined;
  }
});

describe("GET /v1/runs/:runId", () => {
  it("returns 200 with the shared DTO for the caller’s own run", async () => {
    app = await makeApp();
    const res = await app.inject({
      method: "GET",
      url: `/v1/runs/${OWN_RUN}`,
      headers: bearer(KEY_T1),
    });
    expect(res.statusCode).toBe(200);
    // Byte-for-byte the assembler's output — the same DTO the CLI renders.
    expect(res.json()).toEqual(JSON.parse(JSON.stringify(FIXTURE)));
  });

  it("rejects a missing API key with 401", async () => {
    app = await makeApp();
    const res = await app.inject({ method: "GET", url: `/v1/runs/${OWN_RUN}` });
    expect(res.statusCode).toBe(401);
  });

  it("returns 404 for another tenant’s run", async () => {
    app = await makeApp();
    const res = await app.inject({
      method: "GET",
      url: `/v1/runs/${OWN_RUN}`,
      headers: bearer(KEY_T2),
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns an identical 404 shape for a nonexistent run and a cross-tenant run", async () => {
    app = await makeApp();
    const missing = await app.inject({
      method: "GET",
      url: "/v1/runs/does-not-exist",
      headers: bearer(KEY_T1),
    });
    const cross = await app.inject({
      method: "GET",
      url: `/v1/runs/${OWN_RUN}`,
      headers: bearer(KEY_T2),
    });
    expect(missing.statusCode).toBe(404);
    expect(cross.statusCode).toBe(404);
    const strip = (b: {
      error: { code: string; message: string; requestId: string };
    }) => ({
      code: b.error.code,
      message: b.error.message,
    });
    // Same code + message; only the requestId (which is per-request) differs.
    expect(strip(missing.json())).toEqual(strip(cross.json()));
    expect(missing.json().error.code).toBe("not_found");
  });

  it("stamps a requestId into the error envelope", async () => {
    app = await makeApp();
    const res = await app.inject({
      method: "GET",
      url: "/v1/runs/nope",
      headers: bearer(KEY_T1),
    });
    expect(typeof res.json().error.requestId).toBe("string");
    expect(res.json().error.requestId.length).toBeGreaterThan(0);
  });

  it("never leaks secrets or internal fields in the 200 body", async () => {
    app = await makeApp();
    const res = await app.inject({
      method: "GET",
      url: `/v1/runs/${OWN_RUN}`,
      headers: bearer(KEY_T1),
    });
    const raw = res.body;
    expect(raw).not.toContain("planted-secret-value"); // scrubbed in the summary
    expect(raw).not.toContain("trigger-secret-ref"); // trigger_config never mapped in
    expect(raw).not.toContain("worker-secret-id"); // locked_by collapsed to `leased`
    expect(raw).not.toContain("lockedBy");
    expect(raw).not.toContain("leaseExpiresAt");
    // But the safe, summarized view IS present.
    expect(res.json().run.contextSummary.bytes).toBeGreaterThan(0);
    expect(res.json().jobs[0].leased).toBe(true);
  });
});

describe("GET /v1/runs", () => {
  it("rejects a missing API key with 401", async () => {
    app = await makeApp();
    const res = await app.inject({ method: "GET", url: "/v1/runs" });
    expect(res.statusCode).toBe(401);
  });

  it("returns the tenant run list with pagination metadata", async () => {
    app = await makeApp();
    const res = await app.inject({
      method: "GET",
      url: "/v1/runs",
      headers: bearer(KEY_T1),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      items: expect.arrayContaining([
        expect.objectContaining({
          id: "run-2",
          workflowName: "WF",
          status: "succeeded",
        }),
      ]),
      page: { limit: 20, nextCursor: "cursor-1" },
    });
  });

  it("returns an empty list for another tenant", async () => {
    app = await makeApp();
    const res = await app.inject({
      method: "GET",
      url: "/v1/runs",
      headers: bearer(KEY_T2),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      items: [],
      page: { limit: 20, nextCursor: null },
    });
  });

  it("rejects malformed query parameters with 400", async () => {
    app = await makeApp();
    const res = await app.inject({
      method: "GET",
      url: "/v1/runs?status=bogus",
      headers: bearer(KEY_T1),
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects an oversized limit with 400", async () => {
    app = await makeApp();
    const res = await app.inject({
      method: "GET",
      url: "/v1/runs?limit=101",
      headers: bearer(KEY_T1),
    });
    expect(res.statusCode).toBe(400);
  });

  it("passes the cursor through for pagination", async () => {
    app = await makeApp();
    const res = await app.inject({
      method: "GET",
      url: "/v1/runs?cursor=cursor-1",
      headers: bearer(KEY_T1),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().page.nextCursor).toBeNull();
  });
});
