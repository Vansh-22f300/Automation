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
 */
export function createLogger(env: Env, options: LoggerOptions): Logger {
  const pretty = env.NODE_ENV === 'development';

  return pino({
    level: env.LOG_LEVEL,
    base: { service: options.service },
    timestamp: pino.stdTimeFunctions.isoTime,
    // Emit `"level":"info"` rather than pino's numeric default, so logs are
    // readable without a decoder ring in whatever aggregator we end up using.
    formatters: {
      level: (label) => ({ level: label }),
    },
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
  });
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
