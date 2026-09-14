/**
 * Database client.
 *
 * The only place in the codebase that knows a connection pool exists.
 *
 * There is no module-level `db` singleton. A handle is *created* by an
 * entrypoint, which owns its lifetime, and passed down to whatever needs it.
 * That is more typing than an exported global and buys three things worth
 * having: tests can stand up an isolated handle, shutdown is deterministic
 * because exactly one owner calls `close()`, and importing a domain module can
 * never open a socket as a side effect.
 *
 * Everything provider-specific is confined to the connection URL. Local
 * Postgres, Neon, Supabase and RDS differ only in that string (and its
 * `sslmode` parameter), so swapping hosts never reaches domain logic.
 */

import { drizzle } from 'drizzle-orm/node-postgres';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import type { Pool, PoolConfig } from 'pg';

import type { Env } from '@/config/env.js';
import { RetryableError } from '@/domain/errors.js';
import type { Logger } from '@/observability/logger.js';
import * as schema from '@/db/schema.js';

/** The typed Drizzle instance. `typeof schema` is what makes queries typed. */
export type AppDatabase = NodePgDatabase<typeof schema>;

/**
 * The handle passed to a `db.transaction(async (tx) => …)` callback.
 *
 * Derived from `AppDatabase` rather than imported, so it stays exact as the
 * schema evolves. It shares the query surface (`insert`/`select`/`update`) with
 * `AppDatabase`, which lets a repository accept "either the pool or an open
 * transaction" and run the same statement in-band — the seam the queue uses to
 * enqueue a job inside the webhook ingestion transaction.
 */
export type Transaction = Parameters<Parameters<AppDatabase['transaction']>[0]>[0];

/** Anything that can execute a statement: the database itself or a transaction. */
export type Executor = AppDatabase | Transaction;

/**
 * How long a single connection attempt may take before failing. Short on
 * purpose: an unreachable database should fail the boot in seconds, not hang a
 * deploy for a minute.
 */
const CONNECT_TIMEOUT_MS = 10_000;

/** Idle connections are returned to the server rather than held open forever. */
const IDLE_TIMEOUT_MS = 30_000;

/**
 * Server-side cap on any single statement. A backstop against a pathological
 * query pinning a connection indefinitely; the migration runner raises it.
 */
const DEFAULT_STATEMENT_TIMEOUT_MS = 30_000;

/**
 * How long a session may sit idle *inside* a transaction with no query.
 *
 * Once exceeded, PostgreSQL aborts the transaction with
 * `ERROR: idle_in_transaction_session_timeout` and returns the connection to
 * the pool's idle state. This bounds the blast radius of application code that
 * becomes stuck or accidentally leaves a transaction open (e.g. an await that
 * never resolves between `BEGIN` and `COMMIT`).
 *
 * The execution engine runs handlers *outside* any DB transaction (two-transaction
 * model — beginStep / settleStep), so legitimate transactions are only the
 * short bookkeeping around the handler: lock row, insert/update, commit. Those
 * complete in milliseconds, so 30s is generous for normal operation but tight
 * enough to reclaim a leaked transaction before it can hold row locks or bloat
 * `pg_stat_activity` indefinitely.
 *
 * Centralized here (not an env var) so production is always bounded without
 * relying on operator configuration — consistent with `statement_timeout` above.
 * Neon and vanilla PostgreSQL both honor it as a session startup parameter.
 */
export const DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS = 30_000;

export interface DatabaseOptions {
  /** Identifies this process in `pg_stat_activity`. */
  readonly service: string;
  /** Overrides the default statement timeout. Migrations need a longer one. */
  readonly statementTimeoutMs?: number;
}

export interface DatabaseHandle {
  readonly db: AppDatabase;
  /** Escape hatch for raw SQL and for transactions the queue will need later. */
  readonly pool: Pool;
  /** Proves the database is reachable. Throws `RetryableError` if it is not. */
  verifyConnection(): Promise<void>;
  /**
   * A lightweight `select 1`, for the health endpoint. Unlike `verifyConnection`
   * it neither logs nor wraps the error — the caller decides what a failure
   * means. Rejects if the query does not succeed.
   */
  ping(): Promise<void>;
  /** Drains the pool. Idempotent enough to be safe in a shutdown handler. */
  close(): Promise<void>;
}

/** A connection target with the credentials stripped out. */
export interface DatabaseTarget {
  readonly host: string;
  readonly port: string;
  readonly database: string;
}

/**
 * Reduce a connection URL to the parts that are safe to log.
 *
 * Startup logs are the first thing anyone reads when a deploy points at the
 * wrong database, so the host and database name genuinely need to be visible —
 * but the URL also contains a password, and logs get shipped, indexed and
 * retained. Everything except host/port/database is dropped here so that no
 * caller has to remember to redact.
 */
export function describeDatabaseUrl(connectionString: string): DatabaseTarget {
  try {
    const url = new URL(connectionString);
    return {
      host: url.hostname,
      port: url.port === '' ? '5432' : url.port,
      database: decodeURIComponent(url.pathname.replace(/^\//, '')),
    };
  } catch {
    // Unreachable in practice: the URL is validated by the config schema before
    // this is ever called. Degrade to saying nothing rather than risk echoing a
    // malformed string that might still contain a credential.
    return { host: '(unparsable)', port: '(unparsable)', database: '(unparsable)' };
  }
}

/**
 * Create a pool and a Drizzle instance bound to it.
 *
 * Constructing the pool performs no I/O — `pg` connects lazily on first use.
 * Call `verifyConnection()` when the caller wants to know *now*.
 */
export function createDatabase(
  env: Env,
  logger: Logger,
  options: DatabaseOptions,
): DatabaseHandle {
  const effectiveStatementTimeout = options.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS;
  const effectiveIdleTimeout = DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS;

  const config: PoolConfig = {
    connectionString: env.DATABASE_URL,
    max: env.DATABASE_POOL_MAX,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    idleTimeoutMillis: IDLE_TIMEOUT_MS,
    application_name: `ai-workforce-${options.service}`,
    statement_timeout: effectiveStatementTimeout,
    // `pg` forwards this as a startup parameter in Client#getStartupConf();
    // PostgreSQL aborts an idle-in-transaction session with `25P03` after this.
    idle_in_transaction_session_timeout: effectiveIdleTimeout,
    // Pooled Neon (PgBouncer transaction mode) ignores unsupported startup GUCs.
    // `pg-pool` awaits `onConnect` before handing the client out; a rejection
    // quarantines the connection rather than exposing an unconfigured one.
    // Values are internal validated numbers, never user input.
    // `onConnect` is typed as `() => void` in @types/pg but runtime supports Promise
    // (pg-pool `_promiseTry`), so `async` is safe and correctly awaited.
    onConnect: async (client: { query: (sql: string) => Promise<unknown> }) => {
      await client.query(`SET statement_timeout = ${effectiveStatementTimeout}`);
      await client.query(`SET idle_in_transaction_session_timeout = ${effectiveIdleTimeout}`);
    },
  };

  const pool = new pg.Pool(config);

  /**
   * Required, not optional. `pg` emits `error` on the pool when an *idle*
   * connection dies — a server restart, a network blip, a serverless provider
   * reaping connections. With no listener attached, Node treats it as an
   * unhandled `error` event and kills the process. The pool discards the broken
   * client and carries on by itself; all this handler has to do is exist.
   */
  pool.on('error', (error) => {
    logger.error({ err: error }, 'idle database connection failed');
  });

  const db = drizzle(pool, {
    schema,
    logger: {
      /**
       * SQL text only, never the parameter array. Parameters carry the actual
       * customer data — email addresses, webhook payloads, and eventually
       * decrypted credentials. Logging them would defeat every redaction rule
       * applied elsewhere.
       */
      logQuery(query) {
        logger.debug({ sql: query }, 'db query');
      },
    },
  });

  let closed = false;

  return {
    db,
    pool,

    async verifyConnection() {
      const target = describeDatabaseUrl(env.DATABASE_URL);
      try {
        await pool.query('select 1');
      } catch (error) {
        // Unreachable, refused, timed out, DNS failure: transient by nature, so
        // classified retryable even though the caller here is a startup path
        // that will simply exit and let the supervisor try again.
        throw new RetryableError(
          'database_unreachable',
          `Cannot connect to PostgreSQL at ${target.host}:${target.port}/${target.database}`,
          { cause: error, details: { ...target } },
        );
      }
      logger.info({ database: target }, 'database connected');
    },

    async ping() {
      // No wrapping, no logging: the health endpoint calls this on every probe
      // and just needs to know whether a trivial query round-trips.
      await pool.query('select 1');
    },

    async close() {
      if (closed) return;
      closed = true;
      await pool.end();
      logger.debug('database pool closed');
    },
  };
}
