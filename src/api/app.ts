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
import type { WebhookSignatureResolverFactory } from "@/api/routes/webhooks.js";
import type { ApiServer } from "@/api/types.js";
import type { Authenticator } from "@/auth/context.js";
import { RateLimitedError } from "@/api/errors.js";
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
  /**
   * Builds a tenant-scoped webhook signature resolver — looks up the active
   * workflow version's `signature` config (if any) for a `(tenant, source)`
   * pair and resolves the signing secret from the configured connection.
   * Returns null when no signature is required for the source, so the legacy
   * behavior is preserved for sources without a configured signature.
   */
  readonly webhookSignatureResolverFor: WebhookSignatureResolverFactory;
  /** Builds a tenant-scoped workflow repository for an authenticated request. */
  readonly workflowServiceFor: WorkflowServiceFactory;
  /** Builds a tenant-scoped connection repository for an authenticated request. */
  readonly connectionServiceFor: ConnectionServiceFactory;
  /** Builds a tenant-scoped run-inspection reader for an authenticated request. */
  readonly runInspectionFor: RunInspectionServiceFactory;
  /** Structured logger; Fastify attaches a per-request child of it. */
  readonly logger: Logger;
  /**
   * How Fastify derives `request.ip` (and thus the rate-limit key) from
   * `X-Forwarded-For` headers.
   *
   * - `false` (default) — never trust forwarding headers; `request.ip` is
   *   always the socket's remote address. Safe for local development and for
   *   any deployment that is directly reachable. A forged
   *   `X-Forwarded-For` cannot change the bucket.
   * - `true` — trust `X-Forwarded-For` (Fastify `trustProxy: true`). Enable
   *   only when the API is behind a trusted reverse proxy / PaaS that is the
   *   sole ingress and that appends the real client IP. In that deployment the
   *   limiter correctly keys by the forwarded client IP rather than the proxy's
   *   IP, which would otherwise collapse all clients into one bucket.
   * - `string` / `string[]` — a comma-separated list or array of trusted
   *   proxy addresses, CIDRs or the names `loopback`/`linklocal`/`uniquelocal`
   *   (as understood by `@fastify/proxy-addr`). More precise than `true`
   *   because only the named proxies are trusted.
   *
   * Keeping this explicit prevents an untrusted caller from spoofing the
   * rate-limit identity with an arbitrary `X-Forwarded-For` value.
   */
  readonly trustProxy?: boolean | string | string[];
  /**
   * Override the in-memory rate-limit window for testing. When omitted the
   * production defaults (`100` requests per `1 minute`) are used.
   * This is test-only plumbing — no production caller should pass it.
   */
  readonly rateLimit?: {
    readonly max?: number;
    readonly timeWindow?: string | number;
  };
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
    // `trustProxy` controls how `request.ip` (and thus the rate-limit key
    // derived from it) is resolved. The default is `false` — the socket's
    // remote address — so local development and direct-internet deployments
    // never honour a client-supplied `X-Forwarded-For`. When the deployment
    // is behind a trusted reverse proxy / PaaS, the operator explicitly sets
    // `TRUST_PROXY=true` (or a list of proxy CIDRs/names) via the environment;
    // `server.ts` translates that validated env value into this option. That
    // makes the limiter key by the real forwarded client IP instead of the
    // proxy's IP, without allowing an untrusted caller to spoof the bucket
    // with an arbitrary header. Never hard-code `true` here — it would be a
    // global blind trust irrespective of deployment.
    trustProxy: deps.trustProxy ?? false,
    // A unique id per request, surfaced in logs and every error body so a report
    // can be traced. v7 keeps them time-ordered and globally unique across
    // instances (Fastify's default counter is only unique per process).
    genReqId: () => newId(),
  });

  // In-memory fixed-window limiter. Keyed by client IP via `request.ip` by
  // default — which already respects `trustProxy` above — so no custom
  // `keyGenerator` that reads `x-forwarded-for` directly is needed (that
  // would bypass the trust check and allow spoofing). The limits are the
  // conservative per-instance defaults; production-grade distributed quotas
  // remain a later item.
  await app.register(rateLimit, {
    max: deps.rateLimit?.max ?? RATE_LIMIT_MAX,
    timeWindow: deps.rateLimit?.timeWindow ?? RATE_LIMIT_WINDOW,
    // Throw a typed ApiError so the central error handler renders the standard
    // envelope with the correct 429 status. Using an ApiError (instead of a
    // plain object without statusCode) ensures the response is 429, not 500,
    // and that the requestId correlates into the logs.
    errorResponseBuilder: (_request, context) =>
      new RateLimitedError(`Rate limit exceeded, retry in ${Math.ceil(context.ttl / 1000)}s`),
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
    registerWebhookRoutes(
      protectedScope,
      deps.webhookIngestorFor,
      deps.webhookSignatureResolverFor,
    );
    registerRunInspectionRoutes(protectedScope, deps.runInspectionFor);
  });

  return app;
}
