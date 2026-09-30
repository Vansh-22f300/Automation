/**
 * Structured logging.
 *
 * Every log line is JSON in production so it can be queried by tenant, run, or
 * step. `withContext` is the seam for correlation IDs: once the engine exists,
 * the executor will derive a child logger per step run so that every line
 * emitted while handling that step automatically carries its identifiers.
 *
 * Intentionally thin — this is a factory and one helper, not a framework.
 */

import pino from 'pino';
import type { Logger } from 'pino';
import type { Env } from '@/config/env.js';
import { REQUEST_URL_REDACTION } from '@/observability/log-redaction.js';

export type { Logger };

/** Correlation identifiers attached to log lines. Snake_case to match DB columns. */
export interface LogContext {
  readonly tenant_id?: string;
  readonly run_id?: string;
  readonly step_run_id?: string;
}

export interface LoggerOptions {
  /** Which process emitted the line: 'api' | 'worker' | test-specific values. */
  readonly service: string;
}

/**
 * Build the root logger for a process.
 *
 * Pretty-printing is enabled only in development; `pino-pretty` is a
 * devDependency and is deliberately not required in production.
 *
 * A `req.url` censor is always installed (see {@link REQUEST_URL_REDACTION}): the
 * framework logs the request URL verbatim on every request, so sensitive OAuth
 * query values are masked before any line is written, in every environment.
 *
 * `destination` is a test seam: passing a stream captures output and forces the
 * pretty transport off (pino forbids a transport and an explicit destination
 * together). Production callers omit it and log to stdout.
 */
export function createLogger(
  env: Env,
  options: LoggerOptions,
  destination?: pino.DestinationStream,
): Logger {
  const pretty = env.NODE_ENV === 'development' && destination === undefined;

  const config = {
    level: env.LOG_LEVEL,
    base: { service: options.service },
    timestamp: pino.stdTimeFunctions.isoTime,
    // Emit `"level":"info"` rather than pino's numeric default, so logs are
    // readable without a decoder ring in whatever aggregator we end up using.
    formatters: {
      level: (label: string) => ({ level: label }),
    },
    // Censor sensitive OAuth query values (state, code, tokens, …) out of any
    // logged request URL. Path, provider and all other params are preserved, and
    // a URL carrying none of those keys is logged unchanged.
    redact: REQUEST_URL_REDACTION,
    ...(pretty
      ? {
          transport: {
            target: 'pino-pretty',
            options: {
              colorize: true,
              translateTime: 'HH:MM:ss.l',
              ignore: 'pid,hostname',
            },
          },
        }
      : {}),
  };

  return destination === undefined ? pino(config) : pino(config, destination);
}

/**
 * Derive a child logger carrying correlation identifiers.
 *
 * Undefined fields are dropped so log lines stay free of null noise.
 */
export function withContext(logger: Logger, context: LogContext): Logger {
  const bindings: Record<string, string> = {};

  if (context.tenant_id !== undefined) bindings.tenant_id = context.tenant_id;
  if (context.run_id !== undefined) bindings.run_id = context.run_id;
  if (context.step_run_id !== undefined) bindings.step_run_id = context.step_run_id;

  return logger.child(bindings);
}
