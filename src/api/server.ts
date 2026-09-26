/**
 * API process entrypoint.
 *
 * Step 3 scope: boot Fastify with a health endpoint and API-key authentication,
 * connect to PostgreSQL, log clearly, shut everything down cleanly. This file is
 * the composition root's *process* half — it constructs the real dependencies
 * (pool, authenticator, repositories), hands them to `buildApp`, then listens.
 * `buildApp` itself (src/api/app.ts) knows nothing about how they were built,
 * which is what lets the whole app be exercised in tests without a network.
 */

import { loadEnv } from "@/config/env.js";
import { createDatabase } from "@/db/client.js";
import { createLogger } from "@/observability/logger.js";
import { buildApp } from "@/api/app.js";
import { ApiKeyAuthenticator } from "@/auth/api-key-authenticator.js";
import { DrizzleApiKeyStore } from "@/auth/api-key-store.js";
import { AuthService } from "@/auth/auth-service.js";
import { DrizzleAuthUserStore } from "@/auth/auth-user-store.js";
import { DrizzleLoginThrottle } from "@/auth/login-throttle.js";
import { argon2PasswordHasher } from "@/auth/password.js";
import { SessionAuthenticator } from "@/auth/session-authenticator.js";
import { DrizzleSessionStore } from "@/auth/session-store.js";
import { ApiKeyRepository } from "@/repositories/api-key-repository.js";
import { ConnectionRepository } from "@/repositories/connection-repository.js";
import { PostgresJobQueue } from "@/repositories/job-queue.js";
import { RunInspectionRepository } from "@/repositories/run-inspection-repository.js";
import { TenantScope } from "@/repositories/tenant-scope.js";
import { WebhookRepository } from "@/repositories/webhook-repository.js";
import { WebhookSignatureRepository } from "@/repositories/webhook-signature-resolver.js";
import { WorkflowRepository } from "@/repositories/workflow-repository.js";
import { createCredentialCipher } from "@/security/credential-cipher.js";

/** Time allowed for in-flight requests to drain before we stop waiting. */
const SHUTDOWN_TIMEOUT_MS = 10_000;

const env = loadEnv();
const logger = createLogger(env, { service: "api" });

const database = createDatabase(env, logger, { service: "api" });
// Pass the logger so the factory can emit the cleanup warning when both
// `CREDENTIAL_ENCRYPTION_KEY` and a keyring containing `legacy-v1` are
// configured — the legacy var is dead in that configuration and the
// operator can remove it from the environment.
const cipher = createCredentialCipher(env, { logger });

// The producer side of the queue. Enqueuing the first job is unscoped here (the
// tenant is carried on each job and enforced by the composite FK); ingestion
// passes its own transaction so event + run + job commit atomically.
const queue = new PostgresJobQueue(database.db);

// Human-session authentication, wired additively alongside the API-key path.
// One tenant-blind session store backs both the authenticator (resolve a token
// to its tenant+user) and the login/logout service (mint and revoke sessions).
const sessionStore = new DrizzleSessionStore(database.db);
const authService = new AuthService(
  new DrizzleAuthUserStore(database.db),
  argon2PasswordHasher,
  sessionStore,
  new DrizzleLoginThrottle(database.db),
);

const app = await buildApp({
  logger,
  // `TRUST_PROXY` is validated in `src/config/env.ts`; `false` by default so
  // local/dev never trusts `X-Forwarded-For`. When the deployment is behind a
  // trusted reverse proxy / PaaS the operator sets `TRUST_PROXY=true` (or a
  // list of proxy CIDRs) and the limiter then keys by the forwarded client IP.
  trustProxy: env.TRUST_PROXY,
  authenticator: new ApiKeyAuthenticator(new DrizzleApiKeyStore(database.db)),
  // Human sessions: a distinct authenticator over the same session store, so a
  // session token guards `/auth/*` without ever being accepted on `/v1/*`.
  sessionAuthenticator: new SessionAuthenticator(sessionStore),
  authService,
  checkDatabase: () => database.ping(),
  // One tenant-scoped service per authenticated request — the repository is
  // pinned to that tenant and cannot reach across tenants.
  apiKeyServiceFor: (auth) =>
    new ApiKeyRepository(new TenantScope(database.db, auth.tenantId)),
  workflowServiceFor: (auth) =>
    new WorkflowRepository(new TenantScope(database.db, auth.tenantId)),
  connectionServiceFor: (auth) =>
    new ConnectionRepository(
      new TenantScope(database.db, auth.tenantId),
      cipher,
    ),
  webhookIngestorFor: (auth) =>
    new WebhookRepository(new TenantScope(database.db, auth.tenantId), queue),
  // Per-source signature verification. Tenant-scoped; reads the active webhook
  // version's signature config and resolves the secret from the named connection.
  // A configured-but-unavailable secret becomes a verification-refused 401.
  webhookSignatureResolverFor: (auth) =>
    new WebhookSignatureRepository(
      new TenantScope(database.db, auth.tenantId),
      cipher,
    ),
  // Read-only, tenant-scoped run inspection. Same repository (and therefore the
  // same DTO + redaction) the CLI uses — the API adds no query or shaping logic.
  runInspectionFor: (auth) =>
    new RunInspectionRepository(new TenantScope(database.db, auth.tenantId)),
});

let shuttingDown = false;

async function shutdown(reason: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info({ reason }, "api shutting down");

  const timeout = setTimeout(() => {
    logger.error(
      { timeout_ms: SHUTDOWN_TIMEOUT_MS },
      "api shutdown timed out; forcing exit",
    );
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  timeout.unref();

  try {
    // Order matters: stop accepting and finish in-flight requests first, then
    // drain the pool. Closing the database while a request still holds a
    // connection would turn a clean shutdown into a burst of 500s.
    await app.close();
    await database.close();
    logger.info("api stopped cleanly");
  } catch (error) {
    logger.error({ err: error }, "api shutdown failed");
    process.exitCode = 1;
  } finally {
    clearTimeout(timeout);
  }
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

process.on("unhandledRejection", (reason) => {
  logger.fatal({ err: reason }, "unhandled promise rejection");
  process.exitCode = 1;
  void shutdown("unhandledRejection");
});

process.on("uncaughtException", (error) => {
  logger.fatal({ err: error }, "uncaught exception");
  process.exitCode = 1;
  void shutdown("uncaughtException");
});

try {
  // Before the port opens. A process that is listening but cannot reach its
  // database is worse than one that never started: it looks healthy to whatever
  // is watching it.
  await database.verifyConnection();

  await app.listen({ host: env.HOST, port: env.PORT });
  logger.info(
    { host: env.HOST, port: env.PORT, node_env: env.NODE_ENV },
    "api listening",
  );
} catch (error) {
  logger.fatal({ err: error }, "api failed to start");
  await database.close().catch(() => undefined);
  process.exit(1);
}
