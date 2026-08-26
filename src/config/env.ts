/**
 * Environment configuration.
 *
 * Design notes:
 * - `parseEnv` is a pure function that throws. It is unit-testable and safe to
 *   import from anywhere.
 * - `loadEnv` is the fail-fast entrypoint wrapper: it prints a human-readable
 *   report to stderr and exits with code 1. Only process entrypoints
 *   (src/api/server.ts, src/worker/main.ts) should call it.
 * - Nothing is validated as a side effect of importing this module, so tests
 *   and tooling can import it without risking a process exit.
 * - The parsed `Env` is passed explicitly to the code that needs it rather than
 *   read from a global. That keeps the engine and domain layers pure and
 *   testable as the system grows.
 */

import { z } from 'zod';

export const LOG_LEVELS = [
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
  'silent',
] as const;

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  /** Bind address. 127.0.0.1 locally; 0.0.0.0 when containerised. */
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
});

export type Env = z.infer<typeof envSchema>;

/** A single field-level configuration problem. */
export interface EnvIssue {
  readonly variable: string;
  readonly message: string;
}

export class EnvValidationError extends Error {
  readonly issues: readonly EnvIssue[];

  constructor(issues: readonly EnvIssue[]) {
    const detail = issues.map((i) => `  - ${i.variable}: ${i.message}`).join('\n');
    super(`Invalid environment configuration:\n${detail}`);
    this.name = 'EnvValidationError';
    this.issues = issues;
  }
}

/**
 * Validate an environment-variable bag. Throws `EnvValidationError` on failure.
 */
export function parseEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);

  if (!result.success) {
    const issues = result.error.issues.map((issue) => ({
      variable: issue.path.length > 0 ? issue.path.join('.') : '(root)',
      message: issue.message,
    }));
    throw new EnvValidationError(issues);
  }

  return result.data;
}

/**
 * Validate the environment or terminate the process.
 *
 * Called once, first thing, by each process entrypoint. Misconfiguration must
 * be loud and immediate — a half-configured worker that silently misbehaves in
 * production is far more expensive to diagnose than a refused boot.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  try {
    return parseEnv(source);
  } catch (error) {
    if (error instanceof EnvValidationError) {
      process.stderr.write(
        [
          '',
          'FATAL: configuration error — refusing to start.',
          '',
          ...error.issues.map((i) => `  ${i.variable}: ${i.message}`),
          '',
          '  See .env.example for the expected values.',
          '',
        ].join('\n'),
      );
      process.exit(1);
    }
    throw error;
  }
}
