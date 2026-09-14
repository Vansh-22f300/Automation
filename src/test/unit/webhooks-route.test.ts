/**
 * HTTP-boundary tests for the webhook ingestion route.
 *
 * These drive the real `buildApp` via `app.inject` with a fake authenticator and
 * a recording fake ingestor, so the whole request pipeline — auth hook, the raw-
 * body content-type parser, dedupe-key derivation, source validation, response
 * mapping — is exercised with no database. What the *service* does inside its
 * transaction is covered by the integration suite; here we prove the boundary.
 */

import { createHash } from "node:crypto";

import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "@/api/app.js";
import { UnauthorizedError } from "@/api/errors.js";
import type { ApiServer } from "@/api/types.js";
import type { AuthContext, Authenticator } from "@/auth/context.js";
import { newId } from "@/domain/ids.js";
import type {
  IngestInput,
  IngestResult,
  WebhookIngestor,
} from "@/repositories/webhook-repository.js";
import type {
  WebhookSignatureResolver,
} from "@/repositories/webhook-signature-resolver.js";

const VALID_KEY = "valid-key";
const TENANT = "tenant-1";

const authenticator: Authenticator = {
  authenticate: async (credential: string): Promise<AuthContext> => {
    if (credential !== VALID_KEY) throw new UnauthorizedError();
    return { tenantId: TENANT, apiKeyId: "key-1" };
  },
};

/** Records every ingest call and returns a programmable result. */
class RecordingIngestor implements WebhookIngestor {
  readonly calls: IngestInput[] = [];
  next: IngestResult = {
    eventId: newId(),
    runId: null,
    duplicate: false,
    workflowConfigured: false,
  };

  ingest = async (input: IngestInput): Promise<IngestResult> => {
    this.calls.push(input);
    return this.next;
  };
}

/** A signature resolver that never requires signature verification. */
class OpenSignatureResolver implements WebhookSignatureResolver {
  async resolveForSource(): Promise<null> {
    return null;
  }
}

/**
 * A signature resolver that returns a fixed material and counts lookups. Used by
 * the route-level log-safety test to confirm that on a failed verification the
 * structured log entry never records the body, the secret, or the signature.
 */
class FixedSignatureResolver implements WebhookSignatureResolver {
  readonly lookups: string[] = [];
  constructor(
    private readonly config: import("@/domain/webhook-signature.js").WebhookSignatureConfig,
    private readonly secret: string,
  ) {}
  async resolveForSource(
    source: string,
  ): Promise<{ config: import("@/domain/webhook-signature.js").WebhookSignatureConfig; secret: string }> {
    this.lookups.push(source);
    return { config: this.config, secret: this.secret };
  }
}

function silentLogger(): pino.Logger {
  return pino({ level: "silent" });
}

interface Harness {
  app: ApiServer;
  ingestor: RecordingIngestor;
}

async function makeApp(): Promise<Harness> {
  const ingestor = new RecordingIngestor();
  const openResolver = new OpenSignatureResolver();
  const app = await buildApp({
    logger: silentLogger(),
    authenticator,
    checkDatabase: async () => undefined,
    apiKeyServiceFor: () => {
      throw new Error("not used");
    },
    webhookIngestorFor: () => ingestor,
    webhookSignatureResolverFor: () => openResolver,
    workflowServiceFor: () => ({
      listWorkflows: async () => ({ items: [], nextCursor: null }),
    }),
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
    // Minimal run-inspection reader factory for the routes that expect it.
    runInspectionFor: () => ({
      getRun: async () => null,
      listRuns: async () => ({ items: [], nextCursor: null }),
    }),
  });
  return { app, ingestor };
}

const bearer = (key: string) => ({ authorization: `Bearer ${key}` });

let current: Harness | undefined;
afterEach(async () => {
  if (current !== undefined) {
    await current.app.close();
    current = undefined;
  }
});

describe("POST /v1/webhooks/:source — authentication", () => {
  it("rejects a missing API key with 401", async () => {
    current = await makeApp();
    const res = await current.app.inject({
      method: "POST",
      url: "/v1/webhooks/test",
      payload: { a: 1 },
    });
    expect(res.statusCode).toBe(401);
    expect(current.ingestor.calls).toHaveLength(0);
  });

  it("rejects an invalid API key with 401", async () => {
    current = await makeApp();
    const res = await current.app.inject({
      method: "POST",
      url: "/v1/webhooks/test",
      headers: bearer("nope"),
      payload: { a: 1 },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("POST /v1/webhooks/:source — responses", () => {
  it("returns 202 queued when a workflow matched", async () => {
    current = await makeApp();
    current.ingestor.next = {
      eventId: "ev-1",
      runId: "run-1",
      duplicate: false,
      workflowConfigured: true,
    };
    const res = await current.app.inject({
      method: "POST",
      url: "/v1/webhooks/test",
      headers: bearer(VALID_KEY),
      payload: { a: 1 },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({
      event_id: "ev-1",
      run_id: "run-1",
      status: "queued",
    });
  });

  it("returns 202 accepted/not_configured when no workflow matched", async () => {
    current = await makeApp();
    current.ingestor.next = {
      eventId: "ev-2",
      runId: null,
      duplicate: false,
      workflowConfigured: false,
    };
    const res = await current.app.inject({
      method: "POST",
      url: "/v1/webhooks/test",
      headers: bearer(VALID_KEY),
      payload: { a: 1 },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({
      event_id: "ev-2",
      run_id: null,
      status: "accepted",
      workflow: "not_configured",
    });
  });

  it("returns 200 duplicate for a repeated delivery", async () => {
    current = await makeApp();
    current.ingestor.next = {
      eventId: "ev-3",
      runId: "run-3",
      duplicate: true,
      workflowConfigured: true,
    };
    const res = await current.app.inject({
      method: "POST",
      url: "/v1/webhooks/test",
      headers: bearer(VALID_KEY),
      payload: { a: 1 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      event_id: "ev-3",
      run_id: "run-3",
      status: "duplicate",
    });
  });
});

describe("POST /v1/webhooks/:source — dedupe key derivation", () => {
  it("uses X-Event-ID as the dedupe key when provided", async () => {
    current = await makeApp();
    await current.app.inject({
      method: "POST",
      url: "/v1/webhooks/test",
      headers: { ...bearer(VALID_KEY), "x-event-id": "evt-abc" },
      payload: { a: 1 },
    });
    expect(current.ingestor.calls[0]!.dedupeKey).toBe("evt-abc");
  });

  it("falls back to a SHA-256 of the raw body when no X-Event-ID", async () => {
    current = await makeApp();
    const body = JSON.stringify({ a: 1, b: 2 });
    await current.app.inject({
      method: "POST",
      url: "/v1/webhooks/test",
      headers: { ...bearer(VALID_KEY), "content-type": "application/json" },
      payload: body,
    });
    const expected = createHash("sha256")
      .update(Buffer.from(body))
      .digest("hex");
    expect(current.ingestor.calls[0]!.dedupeKey).toBe(expected);
  });

  it("derives the same key for identical raw bodies and different keys for different bodies", async () => {
    current = await makeApp();
    const send = (payload: string) =>
      current!.app.inject({
        method: "POST",
        url: "/v1/webhooks/test",
        headers: { ...bearer(VALID_KEY), "content-type": "application/json" },
        payload,
      });
    await send('{"a":1}');
    await send('{"a":1}');
    await send('{"a":2}');
    const [k1, k2, k3] = current.ingestor.calls.map((c) => c.dedupeKey);
    expect(k1).toBe(k2);
    expect(k1).not.toBe(k3);
  });

  it("passes the parsed payload and validated source through", async () => {
    current = await makeApp();
    await current.app.inject({
      method: "POST",
      url: "/v1/webhooks/github",
      headers: bearer(VALID_KEY),
      payload: { hello: "world" },
    });
    expect(current.ingestor.calls[0]!.source).toBe("github");
    expect(current.ingestor.calls[0]!.payload).toEqual({ hello: "world" });
  });
});

describe("POST /v1/webhooks/:source — validation and limits", () => {
  it("rejects an invalid source with 400", async () => {
    current = await makeApp();
    const res = await current.app.inject({
      method: "POST",
      url: "/v1/webhooks/Bad_Source!",
      headers: bearer(VALID_KEY),
      payload: { a: 1 },
    });
    expect(res.statusCode).toBe(400);
    expect(current.ingestor.calls).toHaveLength(0);
  });

  it("rejects malformed JSON with 400", async () => {
    current = await makeApp();
    const res = await current.app.inject({
      method: "POST",
      url: "/v1/webhooks/test",
      headers: { ...bearer(VALID_KEY), "content-type": "application/json" },
      payload: "{ not valid json",
    });
    expect(res.statusCode).toBe(400);
    expect(current.ingestor.calls).toHaveLength(0);
  });

  it("rejects an empty body with 400", async () => {
    current = await makeApp();
    const res = await current.app.inject({
      method: "POST",
      url: "/v1/webhooks/test",
      headers: { ...bearer(VALID_KEY), "content-type": "application/json" },
      payload: "",
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects an oversized body (over the 1 MiB limit)", async () => {
    current = await makeApp();
    const big = JSON.stringify({ blob: "x".repeat(1_100_000) });
    const res = await current.app.inject({
      method: "POST",
      url: "/v1/webhooks/test",
      headers: { ...bearer(VALID_KEY), "content-type": "application/json" },
      payload: big,
    });
    expect(res.statusCode).toBe(413);
    expect(current.ingestor.calls).toHaveLength(0);
  });
});

describe("POST /v1/webhooks/:source — signature verification (route-level log safety)", () => {
  it("does not persist an event when signature verification refuses, and emits no body/secret/signature in logs", async () => {
    // Use a valid JSON body so the content-type parser doesn't reject the
    // request with 400 before signature verification runs. The literal marker
    // is what we later assert is absent from logs.
    const signatureBody = '{"marker":"MARKER_BODY_DO_NOT_LOG"}';
    const signatureHeaderValue = "MARKER_SIG_DO_NOT_LOG";
    const signatureSecret = "MARKER_SECRET_DO_NOT_LOG";
    const cfg = {
      signing_input: "raw_body" as const,
      algorithm: "hmac-sha256" as const,
      secret_connection_id: "01234567-89ab-7cde-8f01-23456789abcd",
      signature_header: "x-signature",
      signature_encoding: "hex" as const,
    };

    const logLines: string[] = [];
    // Pino accepts a destination stream as the SECOND constructor argument —
    // not as an option. We hand-roll a minimal Sonc-style stream that captures
    // every serialized line into `logLines` so the assertions can scan them.
    const capturingLogger = pino(
      {
        level: "debug",
        formatters: {
          level: (label: string) => ({ level: label }),
        },
      },
      {
        write(chunk: string): number {
          logLines.push(chunk);
          return chunk.length;
        },
      },
    );

    const resolver = new FixedSignatureResolver(cfg, signatureSecret);
    const ingestor = new RecordingIngestor();
    const app = await buildApp({
      logger: capturingLogger,
      authenticator,
      checkDatabase: async () => undefined,
      apiKeyServiceFor: () => {
        throw new Error("not used");
      },
      webhookIngestorFor: () => ingestor,
      webhookSignatureResolverFor: () => resolver,
      workflowServiceFor: () => ({
        listWorkflows: async () => ({ items: [], nextCursor: null }),
      }),
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
      runInspectionFor: () => ({
        getRun: async () => null,
        listRuns: async () => ({ items: [], nextCursor: null }),
      }),
    });

    const res = await app.inject({
      method: "POST",
      url: "/v1/webhooks/test",
      headers: {
        ...bearer(VALID_KEY),
        "content-type": "application/json",
        "x-signature": signatureHeaderValue,
      },
      payload: signatureBody,
    });
    expect(res.statusCode).toBe(401);
    // No ingest call must have been made — failed verification is a hard reject.
    expect(ingestor.calls).toHaveLength(0);
    await app.close();

    const all = logLines.join("");
    expect(all).not.toContain(signatureBody);
    expect(all).not.toContain(signatureSecret);
    expect(all).not.toContain(signatureHeaderValue);
  });

  it("accepts the request and persists nothing dangerous into logs when verification passes", async () => {
    // A valid signature over the body — no signature-header value should ever
    // appear in the log even on success. This second test confirms success-path
    // logging is equally clean.
    const secret = "TEST_SECRET_NEVER_LOGGED";
    const cfg = {
      signing_input: "raw_body" as const,
      algorithm: "hmac-sha256" as const,
      secret_connection_id: "01234567-89ab-7cde-8f01-23456789abcd",
      signature_header: "x-signature",
      signature_encoding: "hex" as const,
    };
    const body = '{"marker":"BODY_DO_NOT_LOG"}';
    const sig = (await import("node:crypto"))
      .createHmac("sha256", secret)
      .update(Buffer.from(body))
      .digest("hex");

    const logLines: string[] = [];
    const capturingLogger = pino(
      {
        level: "debug",
        formatters: { level: (label: string) => ({ level: label }) },
      },
      {
        write(chunk: string): number {
          logLines.push(chunk);
          return chunk.length;
        },
      },
    );

    const resolver = new FixedSignatureResolver(cfg, secret);
    const ingestor = new RecordingIngestor();
    const app = await buildApp({
      logger: capturingLogger,
      authenticator,
      checkDatabase: async () => undefined,
      apiKeyServiceFor: () => {
        throw new Error("not used");
      },
      webhookIngestorFor: () => ingestor,
      webhookSignatureResolverFor: () => resolver,
      workflowServiceFor: () => ({
        listWorkflows: async () => ({ items: [], nextCursor: null }),
      }),
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
      runInspectionFor: () => ({
        getRun: async () => null,
        listRuns: async () => ({ items: [], nextCursor: null }),
      }),
    });

    const res = await app.inject({
      method: "POST",
      url: "/v1/webhooks/test",
      headers: {
        ...bearer(VALID_KEY),
        "content-type": "application/json",
        "x-signature": sig,
      },
      payload: body,
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(200);
    expect(res.statusCode).toBeLessThan(300);
    expect(ingestor.calls).toHaveLength(1);
    await app.close();

    const all = logLines.join("");
    expect(all).not.toContain(body);
    expect(all).not.toContain(secret);
  });
});
