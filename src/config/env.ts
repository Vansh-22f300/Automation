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

/** Schemes PostgreSQL connection URLs are allowed to use. */
const POSTGRES_PROTOCOLS = ['postgres:', 'postgresql:'];

/**
 * A PostgreSQL connection URL.
 *
 * Validation is structural only — it proves the string is a well-formed
 * `postgresql://` URL naming a host and a database. It deliberately does not
 * attempt a connection: configuration parsing must stay synchronous, pure and
 * free of I/O. Reachability is checked separately at startup by
 * `verifyConnection()` in src/db/client.ts.
 *
 * Every failure message describes the *shape* problem without echoing the URL,
 * because the URL carries a password and these messages are written to stderr
 * and may be captured by a process supervisor.
 */
const postgresUrl = z
  .string({ error: 'must be set to a PostgreSQL connection string' })
  .min(1, 'must not be empty')
  .superRefine((value, ctx) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      ctx.addIssue({
        code: 'custom',
        message:
          'must be a valid URL of the form postgresql://user:password@host:5432/database',
      });
      return;
    }

    if (!POSTGRES_PROTOCOLS.includes(url.protocol)) {
      ctx.addIssue({
        code: 'custom',
        message: `must use the postgres:// or postgresql:// scheme (found ${url.protocol}//)`,
      });
    }
    if (url.hostname === '') {
      ctx.addIssue({ code: 'custom', message: 'must include a host' });
    }
    if (url.pathname === '' || url.pathname === '/') {
      ctx.addIssue({
        code: 'custom',
        message: 'must include a database name, for example postgresql://…/ai_workforce',
      });
    }
  });

/**
 * A base URL for the Anthropic-compatible endpoint.
 *
 * Optional. When unset the SDK uses the default (`https://api.anthropic.com`).
 * When set it points the provider at an Anthropic-*compatible* gateway that
 * speaks the same `/v1/messages` protocol — the value must be the gateway's
 * origin (optionally with a base path), NOT include the `/v1` segment: the SDK
 * appends `/v1/messages` itself, so a `…/v1` here would yield `…/v1/v1/messages`.
 * Verified against @anthropic-ai/sdk 0.122.0.
 */
const anthropicBaseUrl = z
  .string()
  .min(1, 'must not be empty when set')
  .superRefine((value, ctx) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      ctx.addIssue({
        code: 'custom',
        message:
          'must be a valid URL, for example https://api.anthropic.com or https://your-gateway.example.com',
      });
      return;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      ctx.addIssue({ code: 'custom', message: `must use http:// or https:// (found ${url.protocol}//)` });
    }
    // The single documented footgun: a trailing /v1 double-prefixes the path.
    if (/\/v1\/?$/.test(url.pathname)) {
      ctx.addIssue({
        code: 'custom',
        message:
          'must not end with /v1 — the SDK appends /v1/messages itself, so a /v1 here yields /v1/v1/messages',
      });
    }
  });

const envSchema = z
  .object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  /** Bind address. 127.0.0.1 locally; 0.0.0.0 when containerised. */
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),

  /**
   * Required. No default and no fallback: an application that silently connects
   * to the wrong database is worse than one that refuses to start. Any standard
   * PostgreSQL URL works — local, Neon, Supabase, RDS — so the provider stays a
   * deployment decision rather than a code decision. TLS is requested through
   * the URL itself (`?sslmode=require`), not a separate variable.
   */
  DATABASE_URL: postgresUrl,

  /**
   * Maximum pooled connections *per process*. Two processes run (api, worker),
   * so the real ceiling against the server is roughly double this. Serverless
   * Postgres plans cap connections aggressively; keep this modest.
   */
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),

  /**
   * Anthropic (Claude) API key. Optional on purpose: the application must boot
   * without it — only code paths that actually call Claude need it, and they
   * validate its presence at the provider layer (see src/llm/claude-provider.ts).
   * It is a secret: never logged, never persisted, never returned to API
   * clients. `.min(1)` rejects an explicitly-empty value with a clear message
   * while an unset variable is simply absent.
   */
  ANTHROPIC_API_KEY: z.string().min(1, 'must not be empty when set').optional(),

  /**
   * Bearer auth token for an Anthropic-compatible gateway. Optional and mutually
   * exclusive with `ANTHROPIC_API_KEY`: when set, the provider authenticates with
   * `Authorization: Bearer <token>` instead of `x-api-key`. This is the seam that
   * lets the same provider talk to gateways (e.g. an Anthropic-compatible relay)
   * that expect bearer auth. Like the API key it is a secret: never logged, never
   * persisted, never returned to clients.
   */
  ANTHROPIC_AUTH_TOKEN: z.string().min(1, 'must not be empty when set').optional(),

  /**
   * Optional override of the Anthropic base URL. Unset → direct Anthropic. Set →
   * an Anthropic-compatible gateway. See `anthropicBaseUrl` above for the /v1 rule.
   */
  ANTHROPIC_BASE_URL: anthropicBaseUrl.optional(),

  /**
   * The Claude model the provider defaults to when a request does not name one.
   * Configurable rather than hardcoded so the model is a deployment decision;
   * any request may still override it. Kept as a free-form string because the
   * set of valid model ids changes over time and is validated by the API, not us.
   * Against a gateway this must be a model id that gateway actually accepts.
   */
  ANTHROPIC_MODEL: z.string().min(1).default('claude-opus-5'),
  })
  .superRefine((env, ctx) => {
    // Reject ambiguous credentials rather than silently picking one. An API key
    // (x-api-key) and a bearer token are two different auth methods; configuring
    // both is a mistake we refuse loudly instead of guessing at.
    if (env.ANTHROPIC_API_KEY !== undefined && env.ANTHROPIC_AUTH_TOKEN !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['ANTHROPIC_AUTH_TOKEN'],
        message:
          'set either ANTHROPIC_API_KEY (direct Anthropic, x-api-key) or ANTHROPIC_AUTH_TOKEN (gateway bearer), not both',
      });
    }
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
