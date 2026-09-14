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

import { isIP } from 'node:net';
import { z } from 'zod';

import { DEFAULT_WORKER_SHUTDOWN_TIMEOUT_MS } from '@/domain/timing.js';

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

/**
 * The credential-encryption master key (`CREDENTIAL_ENCRYPTION_KEY`).
 *
 * Optional: the application must boot without it. Only connection encrypt/decrypt
 * paths need it, and they fail clearly at use time when it is absent (see
 * src/security/credential-cipher.ts). When *present* it must be a real 256-bit key
 * — 64 hex characters or a base64/base64url value decoding to exactly 32 bytes — so
 * a misconfigured key is caught at boot, not at the first credential operation.
 *
 * It is a secret: never logged, never persisted, never returned to clients. The
 * validation below describes only the *shape* problem and never echoes the value.
 * The check is intentionally duplicated (not imported from credential-cipher) to
 * keep the config layer free of a dependency cycle; the byte lengths are the
 * contract, and credential-cipher parses the same shapes.
 */
const credentialEncryptionKey = z
  .string()
  .min(1, 'must not be empty when set')
  .superRefine((value, ctx) => {
    const trimmed = value.trim();
    if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return; // 64 hex chars → 32 bytes.
    if (Buffer.from(trimmed, 'base64').length === 32) return; // base64 → 32 bytes.
    ctx.addIssue({
      code: 'custom',
      message:
        'must decode to 32 bytes (256 bits): supply 64 hex characters or a base64 value of a 32-byte key ' +
        '(generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))")',
    });
  });

/**
 * Trusted proxy configuration for Fastify's `trustProxy` option.
 *
 * Controls whether `request.ip` (and thus the rate limiter's key) is derived
 * from `X-Forwarded-For` headers. The value is deliberately explicit and
 * defaults to `false` so local development is safe by default:
 *
 * - `false` / `0` / unset → do not trust forwarding headers; `request.ip` is
 *   always the socket's remote address. A forged `X-Forwarded-For` cannot
 *   change the rate-limit bucket.
 * - `true` / `1` → trust `X-Forwarded-For` (Fastify `trustProxy: true`).
 *   Enable **only** when the API is deployed behind a trusted reverse
 *   proxy/PaaS that is the sole ingress and that correctly appends the real
 *   client IP. In that deployment the limiter keys by the forwarded client IP
 *   rather than the proxy's IP.
 * - A comma-separated list of trusted proxy addresses, CIDR ranges, or the
 *   predefined names `loopback`, `linklocal`, `uniquelocal` (as understood by
 *   `@fastify/proxy-addr`) is also accepted and passed directly to Fastify
 *   for more precise control (e.g. `TRUST_PROXY=loopback` or
 *   `TRUST_PROXY=10.0.0.0/8,172.16.0.0/12`). This lets the deployment
 *   explicitly name the proxy rather than trusting all hops.
 *
 * The validation below rejects obvious nonsense (empty value, unknown token)
 * with a clear message without echoing the raw value when it might be sensitive,
 * but intentionally stays permissive for CIDR/IP syntax — the underlying
 * `@fastify/proxy-addr` will throw at boot if the compiled trust is invalid,
 * which is fail-fast enough for deployment.
 */
const trustProxySchema = z
  .string()
  .default('false')
  .superRefine((value, ctx) => {
    const trimmed = value.trim();
    if (trimmed === '') {
      ctx.addIssue({ code: 'custom', message: 'must not be empty' });
      return;
    }
    const lower = trimmed.toLowerCase();
    if (lower === 'true' || lower === 'false' || trimmed === '0' || trimmed === '1') return;

    // Comma-separated list: each token must be a known range or an IP/CIDR.
    const parts = trimmed
      .split(',')
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    if (parts.length === 0) {
      ctx.addIssue({ code: 'custom', message: 'must be true, false, 1, 0 or a comma-separated list of IPs/CIDRs/ranges' });
      return;
    }
    for (const part of parts) {
      const lowerPart = part.toLowerCase();
      if (lowerPart === 'loopback' || lowerPart === 'linklocal' || lowerPart === 'uniquelocal') continue;
      const slashIdx = part.indexOf('/');
      if (slashIdx !== -1) {
        const ipPart = part.slice(0, slashIdx);
        const prefixPart = part.slice(slashIdx + 1);
        if (isIP(ipPart) === 0) {
          ctx.addIssue({
            code: 'custom',
            message: `"${part}" is not a valid IP/CIDR — expected like 10.0.0.0/8 or loopback`,
          });
          return;
        }
        const prefixNum = Number(prefixPart);
        if (!Number.isInteger(prefixNum)) {
          ctx.addIssue({
            code: 'custom',
            message: `"${part}" has a non-integer CIDR prefix`,
          });
          return;
        }
        const max = isIP(ipPart) === 6 ? 128 : 32;
        if (prefixNum < 0 || prefixNum > max) {
          ctx.addIssue({
            code: 'custom',
            message: `"${part}" has an out-of-range CIDR prefix (0–${max})`,
          });
          return;
        }
      } else {
        if (isIP(part) === 0) {
          ctx.addIssue({
            code: 'custom',
            message: `"${part}" is not a valid IP, CIDR, or known range (loopback/linklocal/uniquelocal)`,
          });
          return;
        }
      }
    }
  })
  .transform((value) => {
    const trimmed = value.trim();
    const lower = trimmed.toLowerCase();
    if (lower === 'false' || trimmed === '0') return false as const;
    if (lower === 'true' || trimmed === '1') return true as const;
    return trimmed;
  })
  .pipe(z.union([z.boolean(), z.string().min(1)]));

/**
 * Extract a normalized Postgres target (host, port, database) from a connection
 * string for semantic comparison. Reuses the same `URL` parsing as `postgresUrl`
 * and `describeDatabaseUrl` so formatting differences (user, password, query
 * string like `?sslmode=require`) do not bypass isolation checks. Returns null
 * if the string cannot be parsed.
 */
function postgresIdentity(raw: string): { host: string; port: string; database: string } | null {
  try {
    const url = new URL(raw);
    let host = url.hostname.toLowerCase();
    // `URL.hostname` keeps brackets for IPv6 literals (e.g. "[::1]") and may
    // normalize IPv4-mapped addresses (127.0.0.1 → 7f00:1). Strip brackets for
    // semantic comparison so different URL forms of the same target match.
    if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
    const port = url.port === '' ? '5432' : url.port;
    const rawDb = url.pathname.replace(/^\//, '').split('/')[0] ?? '';
    let database: string;
    try {
      database = decodeURIComponent(rawDb);
    } catch {
      database = rawDb;
    }
    return { host, port, database };
  } catch {
    return null;
  }
}

function isLoopbackHost(host: string): boolean {
  let lower = host.toLowerCase();
  if (lower.startsWith('[') && lower.endsWith(']')) lower = lower.slice(1, -1);
  // Covers the common localhost forms without overengineering the full 127/8 range.
  // Handles both the dotted IPv4-mapped form and the hex-normalized form that
  // `URL` produces (127.0.0.1 → 7f00:1, so ::ffff:127.0.0.1 → ::ffff:7f00:1).
  return (
    lower === 'localhost' ||
    lower === '127.0.0.1' ||
    lower === '::1' ||
    lower === '::ffff:127.0.0.1' ||
    lower === '::ffff:7f00:1' ||
    lower === '0:0:0:0:0:ffff:127.0.0.1' ||
    lower === '0:0:0:0:0:ffff:7f00:1'
  );
}

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
   * Test database URL used only by the integration suites. Never used at runtime
   * by the API or worker. Optional so the app boots without it, but when present
   * it must be a valid PostgreSQL URL — and it must not resolve to the same
   * database as `DATABASE_URL`, otherwise destructive tests could target production.
   */
  TEST_DATABASE_URL: postgresUrl.optional(),

  /**
   * Maximum pooled connections *per process*. Two processes run (api, worker),
   * so the real ceiling against the server is roughly double this. Serverless
   * Postgres plans cap connections aggressively; keep this modest.
   */
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),

  /** How long graceful worker shutdown waits for in-flight work before giving up. */
  WORKER_SHUTDOWN_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1, 'must be at least 1ms')
    .max(300_000, 'must not exceed 300000ms (5 minutes)')
    .default(DEFAULT_WORKER_SHUTDOWN_TIMEOUT_MS),

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

  /**
   * Master key for encrypting external-service credentials at rest (AES-256-GCM).
   * Optional so the app boots without it; connection operations that actually need
   * to encrypt/decrypt fail clearly when it is missing. Never logged or persisted.
   */
  CREDENTIAL_ENCRYPTION_KEY: credentialEncryptionKey.optional(),

  /**
   * Multi-key credential keyring (`CREDENTIAL_ENCRYPTION_KEYS`).
   *
   * Format: comma-separated `<kid>:<base64key>` pairs. The **first** entry is the
   * active encrypt key; every subsequent entry is decrypt-only. The literal kid
   * `legacy-v1` is reserved and is always decrypt-only (the parser rejects a
   * keyring whose first entry is `legacy-v1`).
   *
   * Optional: an existing single-key deployment can continue to set only
   * `CREDENTIAL_ENCRYPTION_KEY` (the legacy key is auto-imported as a single
   * `legacy-v1` decrypt-only ring entry, with the same bytes backing the v1
   * write path). Setting both vars is permitted: once a keyring is configured
   * it is the single source of truth — the legacy var is ignored, and a v1
   * writer exists only when the keyring carries a `legacy-v1` entry (a v1
   * write capability always has a matching v1 read capability).
   *
   * Detailed shape validation (kid regex, key bytes, reserved-kid rules) lives
   * in `KeyRing.parse` and surfaces as a typed `CredentialKeyInvalidError` at
   * boot. The check is intentionally duplicated at config-time and at
   * cipher-time so the factory and the cipher agree on the contract.
   */
  CREDENTIAL_ENCRYPTION_KEYS: z.string().min(1, 'must not be empty when set').optional(),

  /**
   * Trusted proxy configuration for Fastify `trustProxy`.
   *
   * See `trustProxySchema` above for the allowed values and security notes.
   * Defaults to `false` so local/dev is safe without any extra config.
   */
  TRUST_PROXY: trustProxySchema,
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

    // Invariant 3a: a gateway base URL without any credential is never valid.
    // The provider (createClaudeProvider) would throw llm_missing_api_key at the
    // first LLM call; failing at env validation gives a clearer, earlier error.
    if (
      env.ANTHROPIC_BASE_URL !== undefined &&
      env.ANTHROPIC_API_KEY === undefined &&
      env.ANTHROPIC_AUTH_TOKEN === undefined
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['ANTHROPIC_BASE_URL'],
        message:
          'ANTHROPIC_BASE_URL is set but no credential is set — set ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN',
      });
    }

    // Invariant 3b: in production a gateway must be reached over TLS.
    if (env.NODE_ENV === 'production' && env.ANTHROPIC_BASE_URL !== undefined) {
      try {
        const url = new URL(env.ANTHROPIC_BASE_URL);
        if (url.protocol !== 'https:') {
          ctx.addIssue({
            code: 'custom',
            path: ['ANTHROPIC_BASE_URL'],
            message: 'must use https:// in production',
          });
        }
      } catch {
        // Leave to the base schema's URL error; no additional issue needed.
      }
    }

    // Invariant 1: production must not point at a development/test database.
    // Hostname checks use URL.hostname normalization (lowercased, brackets stripped)
    // and database checks decode the pathname then look for \"test\" case-insensitively.
    if (env.NODE_ENV === 'production') {
      const identity = postgresIdentity(env.DATABASE_URL);
      if (identity !== null) {
        if (isLoopbackHost(identity.host)) {
          ctx.addIssue({
            code: 'custom',
            path: ['DATABASE_URL'],
            message: 'must not point to localhost in production — use a hosted PostgreSQL URL',
          });
        }
        if (identity.database.toLowerCase().includes('test')) {
          ctx.addIssue({
            code: 'custom',
            path: ['DATABASE_URL'],
            message: 'must not use a test database in production (database name must not contain \"test\")',
          });
        }
      }
    }

    // Invariant 2: the test database must not resolve to the same database as
    // the runtime database. Semantic comparison reuses URL parsing (host/port/database)
    // so harmless formatting differences (different user, password, query string,
    // trailing slash) cannot bypass the check.
    if (env.DATABASE_URL !== undefined && env.TEST_DATABASE_URL !== undefined) {
      const main = postgresIdentity(env.DATABASE_URL);
      const test = postgresIdentity(env.TEST_DATABASE_URL);
      if (main !== null && test !== null) {
        if (
          main.host === test.host &&
          main.port === test.port &&
          main.database.toLowerCase() === test.database.toLowerCase()
        ) {
          ctx.addIssue({
            code: 'custom',
            path: ['TEST_DATABASE_URL'],
            message:
              'must not resolve to the same database as DATABASE_URL — use a separate test database (host, port and database must differ; query strings are ignored)',
          });
        }
      } else if (env.DATABASE_URL === env.TEST_DATABASE_URL) {
        // Fallback for unparsable URLs that already failed base validation;
        // ensures raw equality is still caught without duplicating secret values.
        ctx.addIssue({
          code: 'custom',
          path: ['TEST_DATABASE_URL'],
          message:
            'must not be the same as DATABASE_URL — use a separate test database',
        });
      }
    }

    // Invariant 4: production must bind a non-loopback address.
    // The dev default 127.0.0.1 would start yet be unreachable on a PaaS/container,
    // looking healthy to a supervisor. Force an explicit HOST. Reuse the same
    // loopback check as DATABASE_URL so bracketed and hex-normalized forms are covered.
    if (env.NODE_ENV === 'production' && isLoopbackHost(env.HOST)) {
      ctx.addIssue({
        code: 'custom',
        path: ['HOST'],
        message:
          'must not be 127.0.0.1 in production — set HOST=0.0.0.0 for containers/PaaS (or another non-loopback address)',
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
