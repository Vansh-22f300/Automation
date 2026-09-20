/**
 * Worker process entrypoint.
 *
 * Step 5 built the durable queue and this consumer; Step 6 gives it a real
 * dispatcher. This process boots, connects to PostgreSQL, and runs two
 * long-lived loops against the `jobs` table:
 *
 *   - a `Worker` that claims one pending job at a time (`FOR UPDATE SKIP
 *     LOCKED`), verifies the job's run exists, and hands it to the executor;
 *   - a `Reaper` that periodically returns jobs with expired leases to the
 *     queue, so a crashed worker never loses its in-flight work.
 *
 * The dispatcher is the `WorkflowExecutor`: it advances a run by exactly one
 * step per job, records a `workflow_step_runs` row, updates the run's context
 * and status, and enqueues the next step's job — all in one transaction. A job
 * is marked `done` only after its step actually succeeded, `failed` when the
 * step failed, and left for the reaper on an unexpected mid-execution error.
 *
 * The composition root wires the real dependencies (database, queue, dispatcher)
 * and owns process concerns: startup verification, signal handling, and a
 * time-bounded shutdown that stops claiming, drains the loops (handing back the
 * lease of anything still in flight when the wait runs out) and closes the pool.
 *
 * Testability: this file is intentionally *not* unit-tested. Its responsibilities
 * are process bootstrap (loadEnv → real PG pool → real `process.on` signal
 * handlers → `process.exit`), and the only realistic way to cover those without
 * mocking the runtime is an end-to-end test that boots a real worker process
 * against a real Postgres — which is the integration suite's job and is out of
 * scope for Item 11's hardening pass. The classes wired up here
 * (`Worker`, `Reaper`, `WorkerHeartbeat`, `PostgresJobQueue`, `WorkflowExecutor`)
 * are each independently exercised in `src/test/unit/` with fakes. The shutdown
 * sequence (worker.stop → reaper.stop → database.close → exit) is the only
 * coordination logic owned by this file, and the parts of it that have
 * observable failure modes (`Worker.stop` draining in-flight work, `Worker.stop`
 * timing out and handing back its lease, the unhandled-rejection / uncaught-
 * exception guards) are already covered by `worker.test.ts > Worker.stop` and
 * `reaper.test.ts`. Lifting the composition into a `createWorkerProcess(deps)`
 * function just so it could be unit-tested is rejected here on purpose: a
 * composition root that has been factored into injectable dependencies is
 * rarely the same code as the one a process actually boots from, and the value
 * of a unit test that mocks the runtime is small.
 */

import { and, eq } from 'drizzle-orm';

import { loadEnv } from '@/config/env.js';
import { createSlackToolRegistry } from '@/connectors/slack/index.js';
import { createDatabase } from '@/db/client.js';
import { workflowRuns } from '@/db/schema.js';
import type { ConnectionResolver } from '@/domain/connection.js';
import type { EffectLedger } from '@/domain/effect-ledger.js';
import { isAppError } from '@/domain/errors.js';
import { newId } from '@/domain/ids.js';
import type { LlmProvider } from '@/domain/llm.js';
import { defaultStepHandlerRegistry } from '@/domain/step-handler.js';
import { createRetryPolicy } from '@/domain/retry-policy.js';
import { createClaudeProvider } from '@/llm/claude-provider.js';
import { createLogger } from '@/observability/logger.js';
import { ConnectionRepository } from '@/repositories/connection-repository.js';
import { EffectLedgerRepository } from '@/repositories/effect-ledger-repository.js';
import { WorkflowExecutor } from '@/repositories/execution-engine.js';
import { PostgresJobQueue } from '@/repositories/job-queue.js';
import { TenantScope } from '@/repositories/tenant-scope.js';
import { createCredentialCipher } from '@/security/credential-cipher.js';
import { Reaper } from '@/worker/reaper.js';
import { Worker } from '@/worker/worker.js';
import type { RunExistenceCheck } from '@/worker/worker.js';
import { POLL_INTERVAL_MS, REAPER_INTERVAL_MS, WorkerHeartbeat } from '@/worker/heartbeat.js';

/**
 * How often the worker process emits a `worker_heartbeat` summary log line.
 * Independent of the heartbeat *stale* threshold inside `WorkerHeartbeat`,
 * which is derived from poll + reaper intervals. This one is just the cadence
 * at which the operator gets a fresh snapshot in logs.
 */
const HEARTBEAT_LOG_INTERVAL_MS = 30_000;
/**
 * Extra time the force-exit watchdog allows *beyond* `WORKER_SHUTDOWN_TIMEOUT_MS`.
 *
 * `Worker.stop()` gives up waiting at that timeout and then still has real work to
 * do: hand its lease back, stop the reaper, close the pool. A watchdog armed at
 * exactly the same deadline would kill the process at the instant that tail begins
 * and lose the lease release — the thing that makes the job immediately
 * re-claimable rather than stranded until its lease lapses. This grace bounds the
 * tail; it is not part of the wait for the step itself.
 */
const SHUTDOWN_GRACE_MS = 5_000;

// The durable business-retry policy. A retryable step failure is deferred by an
// equal-jitter backoff and re-claimed after its `run_at`; crash recovery (the
// reaper's `attempt` counter) is deliberately separate and does not consume this
// budget. Constructed once and shared with the executor.
const retryPolicy = createRetryPolicy();

const env = loadEnv();
const logger = createLogger(env, { service: 'worker' });

// A stable identity for this process, stamped onto every lease it takes and
// every log line it writes, so a job can be traced to the worker that ran it.
const workerId = `worker-${process.pid}-${newId().slice(0, 8)}`;

const database = createDatabase(env, logger, { service: 'worker' });
const queue = new PostgresJobQueue(database.db);

// In-memory heartbeat / lifecycle tracker for this worker process. The same
// instance is shared by the Worker, the Reaper and the periodic summary log
// below, so the snapshot an operator sees is the union of all three. There is
// no DB table, no Redis, no shared file — the state lives only in this
// process and is exposed via structured logs.
const heartbeat = new WorkerHeartbeat();

// Build the LLM provider from config if a credential is present. The worker must
// boot without one — nothing constructs a provider until an `llm` step runs — so
// a missing credential is a warning, not a fatal error: `llm` steps then fail
// cleanly at execution (via the unconfigured handler) rather than crashing boot.
let llmProvider: LlmProvider | undefined;
try {
  llmProvider = createClaudeProvider(env, logger);
} catch (error) {
  if (isAppError(error) && error.code === 'llm_missing_api_key') {
    logger.warn('no LLM credential configured; llm steps will fail until ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN is set');
  } else {
    throw error;
  }
}

// The tool wiring an `llm` step uses when it declares tools. The Slack registry is
// the model-facing catalogue (name/description/inputSchema only); the resolver
// factory builds a tenant-scoped connection resolver on demand. Both are safe to
// build without a credential key — the cipher only demands one when an actual
// decrypt runs — so the worker still boots when no connection is configured; a
// tool call for a tenant with no key then fails cleanly at execution.
const toolRegistry = createSlackToolRegistry({ logger });
const cipher = createCredentialCipher(env, { logger });
const resolverFactory = (tenantId: string): ConnectionResolver =>
  new ConnectionRepository(new TenantScope(database.db, tenantId), cipher);
// The effect ledger makes each tool call retry-safe: it reserves the external
// effect under `(tenant_id, idempotency_key)` and settles the outcome durably, so a
// redelivered job replays a stored success instead of resending, and an unknown
// outcome surfaces as ambiguous rather than silently duplicating. Bound per tenant,
// exactly like the resolver.
const effectLedgerFactory = (tenantId: string): EffectLedger =>
  new EffectLedgerRepository(new TenantScope(database.db, tenantId));

/** The worker's job-validity check: does this run still exist for this tenant? */
const runExists: RunExistenceCheck = async (tenantId, runId) => {
  const [row] = await database.db
    .select({ id: workflowRuns.id })
    .from(workflowRuns)
    .where(and(eq(workflowRuns.tenantId, tenantId), eq(workflowRuns.id, runId)))
    .limit(1);
  return row !== undefined;
};

const worker = new Worker({
  queue,
  // The real execution engine: it advances a run by exactly one step per job,
  // recording the step run, updating the run, and enqueuing the next job — all
  // atomically. The worker stays ignorant of what a `noop` step does.
  dispatcher: new WorkflowExecutor({
    db: database.db,
    queue,
    registry: defaultStepHandlerRegistry({
      ...(llmProvider !== undefined ? { llmProvider } : {}),
      toolRegistry,
      resolverFactory,
      effectLedgerFactory,
    }),
    logger,
    retryPolicy,
  }),
  logger,
  workerId,
  pollIntervalMs: POLL_INTERVAL_MS,
  runExists,
  shutdownTimeoutMs: env.WORKER_SHUTDOWN_TIMEOUT_MS,
  heartbeat,
});

const reaper = new Reaper({ queue, logger, intervalMs: REAPER_INTERVAL_MS, heartbeat });

/**
 * Emit one summary log line per `HEARTBEAT_LOG_INTERVAL_MS`. The fields mirror
 * the Worker's `WorkerHeartbeatSnapshot` exactly so a log-shipping consumer
 * can match on shape. Identifiers-only: no tenant id, no run id, no payload,
 * no credential. `.unref()` so the timer never holds the process open past
 * shutdown — `clearInterval` in `shutdown()` is the primary teardown.
 */
const heartbeatTimer = setInterval(() => {
  const snap = heartbeat.snapshot();
  logger.info(
    {
      heartbeat_state: snap.state,
      uptime_seconds: snap.uptimeSeconds,
      last_tick_at: snap.lastTickAt,
      last_tick_age_ms: snap.lastTickAgeMs,
      stale: snap.isStale,
      in_flight: snap.inFlight,
      counts: snap.counts,
    },
    'worker_heartbeat',
  );
}, HEARTBEAT_LOG_INTERVAL_MS);
heartbeatTimer.unref();

let shuttingDown = false;

async function shutdown(reason: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  // The absolute ceiling on this process's lifetime from here. `Worker.stop()`
  // bounds its own wait; this bounds everything after it, so a hung pool close or
  // reaper stop cannot keep a terminating process alive indefinitely either.
  const forceExitAfterMs = env.WORKER_SHUTDOWN_TIMEOUT_MS + SHUTDOWN_GRACE_MS;

  logger.info(
    {
      reason,
      worker_id: workerId,
      shutdown_timeout_ms: env.WORKER_SHUTDOWN_TIMEOUT_MS,
      force_exit_after_ms: forceExitAfterMs,
    },
    'worker shutting down',
  );

  const timeout = setTimeout(() => {
    logger.error(
      {
        timeout_ms: forceExitAfterMs,
        shutdown_timeout_ms: env.WORKER_SHUTDOWN_TIMEOUT_MS,
      },
      'worker process shutdown timed out; forcing exit',
    );
    process.exit(1);
  }, forceExitAfterMs);
  timeout.unref();

  try {
    // Stop claiming new work first, then stop the reaper, then release the pool.
    // Draining the loops before closing the pool avoids tearing a connection out
    // from under an in-flight claim or sweep.
    clearInterval(heartbeatTimer);
    await worker.stop();
    await reaper.stop();
    await database.close();
    logger.info('worker stopped cleanly');
  } catch (error) {
    logger.error({ err: error }, 'worker shutdown failed');
    process.exitCode = 1;
  } finally {
    clearTimeout(timeout);
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'unhandled promise rejection');
  process.exitCode = 1;
  void shutdown('unhandledRejection');
});

process.on('uncaughtException', (error) => {
  logger.fatal({ err: error }, 'uncaught exception');
  process.exitCode = 1;
  void shutdown('uncaughtException');
});

try {
  // A worker that cannot reach the database has nothing to do; fail the boot and
  // let the supervisor restart it.
  await database.verifyConnection();

  worker.start();
  reaper.start();

  logger.info(
    {
      node_env: env.NODE_ENV,
      worker_id: workerId,
      poll_interval_ms: POLL_INTERVAL_MS,
      reaper_interval_ms: REAPER_INTERVAL_MS,
      shutdown_timeout_ms: env.WORKER_SHUTDOWN_TIMEOUT_MS,
    },
    'worker running',
  );
} catch (error) {
  logger.fatal({ err: error }, 'worker failed to start');
  await database.close().catch(() => undefined);
  process.exit(1);
}
