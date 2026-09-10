/**
 * API composition root.
 *
 * `buildApp` wires a Fastify instance from explicit dependencies and returns it
 * *without listening*. That separation is deliberate and load-bearing:
 *
 * - **Testable.** Tests build an app with fake dependencies (an in-memory
 *   authenticator, a health check that throws) and drive it with
 *   `app.inject(...)` — no port, no database, no network. Everything the routes
 *   do is observable offline.
 * - **Framework-contained.** Only this file and the hooks/routes it registers
 *   touch Fastify. Domain and repository code depends on the small interfaces in
 *   `deps`, not on Fastify types, so the web framework stays replaceable.
 *
 * The real process wiring — construct the pool, the authenticator, the
 * repositories, then `listen` — lives in `server.ts`.
 */

import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import type { Logger } from "pino";

import { registerApiKeyAuth } from "@/api/auth-hook.js";
import { registerErrorHandling } from "@/api/error-handler.js";
import { registerApiKeyRoutes } from "@/api/routes/api-keys.js";
import type { ApiKeyServiceFactory } from "@/api/routes/api-keys.js";
import { registerConnectionRoutes } from "@/api/routes/connections.js";
import type { ConnectionServiceFactory } from "@/api/routes/connections.js";
import { registerHealthRoute } from "@/api/routes/health.js";
import type { DatabaseHealthCheck } from "@/api/routes/health.js";
import { registerRunInspectionRoutes } from "@/api/routes/runs.js";
import type { RunInspectionServiceFactory } from "@/api/routes/runs.js";
import { registerWorkflowRoutes } from "@/api/routes/workflows.js";
import type { WorkflowServiceFactory } from "@/api/routes/workflows.js";
import { registerWebhookRoutes } from "@/api/routes/webhooks.js";
import type { WebhookIngestorFactory } from "@/api/routes/webhooks.js";
import type { ApiServer } from "@/api/types.js";
import type { Authenticator } from "@/auth/context.js";
import { newId } from "@/domain/ids.js";

export interface AppDependencies {
  /** Resolves credentials to a tenant. */
  readonly authenticator: Authenticator;
  /** Probes database reachability for `/healthz`. */
  readonly checkDatabase: DatabaseHealthCheck;
  /** Builds a tenant-scoped API-key service for an authenticated request. */
  readonly apiKeyServiceFor: ApiKeyServiceFactory;
  /** Builds a tenant-scoped webhook ingestor for an authenticated request. */
  readonly webhookIngestorFor: WebhookIngestorFactory;
  /** Builds a tenant-scoped workflow repository for an authenticated request. */
  readonly workflowServiceFor: WorkflowServiceFactory;
  /** Builds a tenant-scoped connection repository for an authenticated request. */
  readonly connectionServiceFor: ConnectionServiceFactory;
  /** Builds a tenant-scoped run-inspection reader for an authenticated request. */
  readonly runInspectionFor: RunInspectionServiceFactory;
  /** Structured logger; Fastify attaches a per-request child of it. */
  readonly logger: Logger;
}

/**
 * A deliberately conservative in-memory limit. Its job is to blunt credential-
 * stuffing and accidental hammering on a single instance, not to be a real
 * distributed quota. It is per-instance and resets on restart; production-grade
 * distributed rate limiting (shared store, per-tenant quotas) arrives later and
 * is called out in the README. No Redis is introduced for this.
 */
const RATE_LIMIT_MAX = 100;
const RATE_LIMIT_WINDOW = "1 minute";

/**
 * Baseline headers for an API response. These are deliberately limited to
 * transport/content-sniffing/frame/referrer controls that do not assume the API
 * serves browser documents. CSP is intentionally absent: this service returns
 * JSON and does not own a browser execution context.
 */
const API_SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "permissions-policy": "geolocation=(), microphone=(), camera=()",
} as const;

export async function buildApp(deps: AppDependencies): Promise<ApiServer> {
  const app: ApiServer = Fastify({
    loggerInstance: deps.logger,
    // 1 MiB. Payloads are small; a low ceiling is a cheap DoS guard.
    bodyLimit: 1_048_576,
    // Behind a trusted proxy this must be enabled so the client IP (and thus the
    // rate-limit key) is the real one and not the proxy's. Off by default so a
    // spoofed X-Forwarded-For cannot defeat the limiter when we are not proxied.
    trustProxy: false,
    // A unique id per request, surfaced in logs and every error body so a report
    // can be traced. v7 keeps them time-ordered and globally unique across
    // instances (Fastify's default counter is only unique per process).
    genReqId: () => newId(),
  });

  // In-memory fixed-window limiter. Keyed by client IP by default.
  await app.register(rateLimit, {
    max: RATE_LIMIT_MAX,
    timeWindow: RATE_LIMIT_WINDOW,
    // Route the 429 through our envelope rather than the plugin's default shape.
    errorResponseBuilder: (request, context) => ({
      error: {
        code: "rate_limited",
        message: `Rate limit exceeded, retry in ${Math.ceil(context.ttl / 1000)}s`,
        requestId: request.id,
      },
    }),
  });

  registerErrorHandling(app);

  // Apply the same baseline headers to successful responses and error responses.
  // `onSend` runs after route/error handling, so this does not alter response
  // bodies, status codes, authentication, or route-specific behaviour.
  app.addHook("onSend", async (_request, reply, payload) => {
    for (const [name, value] of Object.entries(API_SECURITY_HEADERS)) {
      reply.header(name, value);
    }
    return payload;
  });

  // Preserve the exact request bytes before JSON parsing. Webhook signature
  // verification (HMAC) will need the raw body, and it must be the untouched
  // bytes — re-serialising the parsed object would change them. This replaces
  // the default JSON parser for every route; parse failures surface as 400.
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (request, body, done) => {
      const raw = body as Buffer;
      request.rawBody = raw;
      if (raw.length === 0) {
        done(null, undefined);
        return;
      }
      try {
        done(null, JSON.parse(raw.toString("utf8")) as unknown);
      } catch (error) {
        const err = error as Error & { statusCode?: number };
        err.statusCode = 400;
        done(err, undefined);
      }
    },
  );

  // Public, unauthenticated route. Registered at the top level so no auth hook
  // applies to it; it exempts itself from the rate limiter internally.
  registerHealthRoute(app, deps.checkDatabase);

  // Everything below requires a valid API key. Encapsulated so the auth hook does
  // not touch the public route above. The plugin callback's instance is typed
  // with Fastify's default logger; we re-assert our pino-typed `ApiServer` here
  // (the two differ only in the logger generic, which is structurally harmless).
  await app.register(async (rawScope) => {
    const protectedScope = rawScope as unknown as ApiServer;
    registerApiKeyAuth(protectedScope, deps.authenticator);
    registerApiKeyRoutes(protectedScope, deps.apiKeyServiceFor);
    registerWorkflowRoutes(protectedScope, deps.workflowServiceFor);
    registerConnectionRoutes(protectedScope, deps.connectionServiceFor);
    registerWebhookRoutes(protectedScope, deps.webhookIngestorFor);
    registerRunInspectionRoutes(protectedScope, deps.runInspectionFor);
  });

  return app;
}
