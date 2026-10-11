/**
 * `github-get-user-smoke` — a minimal, GitHub read-only tool smoke test.
 *
 * Runs EXACTLY ONE tool, `github_get_authenticated_user` (no arguments), through the
 * REAL production execution path — the same `ToolExecutor` + `RefreshingConnectionResolver`
 * (+ `RefreshingTokenSource`) the worker uses — against a stored, tenant-scoped GitHub
 * connection, and reports a sanitized PASS/FAIL plus the connected login. Its one
 * external operation is `GET https://api.github.com/user`.
 *
 *   pnpm github:get-user-smoke <tenantId> <connectionId>
 *
 * SIDE EFFECTS (documented, NOT hidden): because it uses the real resolver, a successful
 * resolution does `UPDATE connections SET last_used_at = now()` on the resolved row, and
 * — if the stored OAuth access token is at/near expiry — the resolver refreshes it and
 * persists the rotated credential via a compare-and-swap UPDATE while GitHub rotates the
 * refresh token. So a LIVE run is NOT database-read-only. It does NOT create issues, run
 * workflows/webhooks/jobs, call an LLM, or wire an effect ledger. The diagnostic registry
 * holds ONLY the read tool — `github_create_issue` is never registered here. The
 * connection is chosen by trusted (tenantId, connectionId) config; no token or credential
 * is ever accepted as an argument or printed.
 */
import { pathToFileURL } from 'node:url';

import { parseEnv } from '@/config/env.js';
import type { Env } from '@/config/env.js';
import {
  createFetchGithubTransport,
  createGithubGetUserTool,
  GITHUB_GET_AUTHENTICATED_USER_TOOL,
  GithubUserConnector,
} from '@/connectors/github/index.js';
import type { GithubTransport } from '@/connectors/github/index.js';
import { createDatabase } from '@/db/client.js';
import type { DatabaseHandle } from '@/db/client.js';
import type { ConnectionMetadata } from '@/domain/connection.js';
import { isAppError } from '@/domain/errors.js';
import { newId } from '@/domain/ids.js';
import type { ToolCall, ToolResult } from '@/domain/tool.js';
import { ToolExecutor } from '@/domain/tool-executor.js';
import type { ToolExecutionOptions } from '@/domain/tool-executor.js';
import { ToolRegistry } from '@/domain/tool-registry.js';
import { GITHUB_PROVIDER, loadOAuthProviders } from '@/oauth/providers/index.js';
import { OAuthProviderRegistry } from '@/oauth/provider-config.js';
import { RefreshingConnectionResolver } from '@/oauth/refreshing-connection-resolver.js';
import { OAuthTokenClient } from '@/oauth/token-client.js';
import { RefreshingTokenSource } from '@/oauth/token-source.js';
import { createLogger } from '@/observability/logger.js';
import type { Logger } from '@/observability/logger.js';
import { ConnectionRepository } from '@/repositories/connection-repository.js';
import { TenantScope } from '@/repositories/tenant-scope.js';
import { CredentialCipher, createCredentialCipher } from '@/security/credential-cipher.js';
/** The ONE tool this diagnostic may run. */
export const GITHUB_SMOKE_TOOL = GITHUB_GET_AUTHENTICATED_USER_TOOL;

/** UUID shape (incl. UUIDv7). Both ids are validated before any DB access. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isValidId(value: string | undefined): value is string {
  return value !== undefined && UUID_RE.test(value);
}

/**
 * Build a registry containing ONLY `github_get_authenticated_user`. `github_create_issue`
 * is deliberately NOT registered, so this diagnostic cannot mutate a repository by misuse.
 */
export function buildDiagnosticRegistry(transport: GithubTransport, logger?: Logger): ToolRegistry {
  const connector = new GithubUserConnector({ transport, ...(logger !== undefined ? { logger } : {}) });
  return new ToolRegistry().register(createGithubGetUserTool(connector));
}

export interface SmokeVerdict {
  readonly outcome: 'pass' | 'fail';
  readonly reason: 'ok' | 'connection_not_found' | 'wrong_provider' | 'connection_not_active' | 'tool_failed';
  readonly login?: string;
  readonly errorCode?: string;
  readonly exitCode: 0 | 1;
}

/** Minimal executor seam so a test can drive the verdict logic with a fake. */
export interface ToolExecutorLike {
  execute(call: ToolCall, options: ToolExecutionOptions): Promise<ToolResult>;
}

export interface RunSmokeOptions {
  readonly executor: ToolExecutorLike;
  readonly getMetadata: (connectionId: string) => Promise<ConnectionMetadata | null>;
  readonly tenantId: string;
  readonly connectionId: string;
  readonly stdout?: NodeJS.WritableStream;
}
const REASON_MESSAGE: Record<SmokeVerdict['reason'], string> = {
  ok: 'the GitHub connection resolved and GET /user returned the authenticated account.',
  connection_not_found: 'no connection with that id exists in this tenant.',
  wrong_provider: 'that connection is not a GitHub connection.',
  connection_not_active: 'that connection is not active.',
  tool_failed: 'github_get_authenticated_user failed (see the sanitized code).',
};

function writeVerdict(out: NodeJS.WritableStream, v: SmokeVerdict): void {
  const head =
    v.outcome === 'pass'
      ? `RESULT: PASS — login=${v.login ?? '(unknown)'}`
      : `RESULT: FAIL${v.errorCode !== undefined ? ` [${v.errorCode}]` : ''}`;
  out.write(`${head} — ${REASON_MESSAGE[v.reason]}\n`);
}

/**
 * Core: pre-check the connection with READ-ONLY metadata (never touching last_used_at),
 * then run the one tool. Emits a single sanitized PASS/FAIL + the login; never a token,
 * credential, envelope, or raw exception.
 */
export async function runGithubGetUserSmoke(options: RunSmokeOptions): Promise<SmokeVerdict> {
  const out = options.stdout ?? process.stdout;
  const meta = await options.getMetadata(options.connectionId);

  let verdict: SmokeVerdict;
  if (meta === null) {
    verdict = { outcome: 'fail', reason: 'connection_not_found', exitCode: 1 };
  } else if (meta.provider !== GITHUB_PROVIDER) {
    verdict = { outcome: 'fail', reason: 'wrong_provider', exitCode: 1 };
  } else if (meta.status !== 'active') {
    verdict = { outcome: 'fail', reason: 'connection_not_active', exitCode: 1 };
  } else {
    const call: ToolCall = { id: newId(), name: GITHUB_SMOKE_TOOL, arguments: {} };
    try {
      const result = await options.executor.execute(call, {
        // No runId/stepRunId ⇒ the executor's effect-ledger branch is never taken even
        // if a ledger were wired; the connectionRef is trusted config, not an argument.
        context: { tenantId: options.tenantId, toolName: GITHUB_SMOKE_TOOL },
        connectionRef: { provider: GITHUB_PROVIDER, connectionId: options.connectionId },
      });
      if (result.success) {
        const login = (result.output as { login?: unknown } | null | undefined)?.login;
        verdict = { outcome: 'pass', reason: 'ok', ...(typeof login === 'string' ? { login } : {}), exitCode: 0 };
      } else {
        verdict = {
          outcome: 'fail',
          reason: 'tool_failed',
          ...(result.error?.code !== undefined ? { errorCode: result.error.code } : {}),
          exitCode: 1,
        };
      }
    } catch (error) {
      // The executor returns a classified ToolResult for every AppError; a throw here is
      // a truly unexpected (non-AppError) condition. Convert it to a sanitized verdict —
      // a raw message or stack must never reach stdout.
      verdict = {
        outcome: 'fail',
        reason: 'tool_failed',
        errorCode: isAppError(error) ? error.code : 'unexpected_error',
        exitCode: 1,
      };
    }
  }
  writeVerdict(out, verdict);
  return verdict;
}
interface RealSmokeInput {
  readonly env: Env;
  readonly logger: Logger;
  readonly cipher: CredentialCipher;
  readonly database: DatabaseHandle;
  readonly tenantId: string;
  readonly connectionId: string;
  readonly stdout: NodeJS.WritableStream;
}

/** Default wiring: the REAL production-style executor + refreshing resolver, no ledger. */
async function realRunSmoke(input: RealSmokeInput): Promise<SmokeVerdict> {
  const repository = new ConnectionRepository(new TenantScope(input.database.db, input.tenantId), input.cipher);
  const tokenSource = new RefreshingTokenSource(
    new OAuthTokenClient(),
    new OAuthProviderRegistry(loadOAuthProviders(input.env)),
  );
  const resolver = new RefreshingConnectionResolver(repository, tokenSource);
  const registry = buildDiagnosticRegistry(createFetchGithubTransport(), input.logger);
  const executor = new ToolExecutor(registry, resolver); // no effect ledger, by design
  return runGithubGetUserSmoke({
    executor,
    getMetadata: (id) => repository.getMetadata(id),
    tenantId: input.tenantId,
    connectionId: input.connectionId,
    stdout: input.stdout,
  });
}

/** Injectable process-level dependencies, so init-failure and lifecycle paths are testable. */
export interface GithubSmokeCliDeps {
  readonly loadEnv: () => Env;
  readonly createLogger: (env: Env) => Logger;
  readonly createCipher: (env: Env, logger: Logger) => CredentialCipher;
  readonly createDatabase: (env: Env, logger: Logger) => DatabaseHandle;
  /** Seam so lifecycle tests need no real DB-backed resolver chain. Defaults to real wiring. */
  readonly runSmoke?: (input: RealSmokeInput) => Promise<SmokeVerdict>;
}

const DEFAULT_DEPS: GithubSmokeCliDeps = {
  // parseEnv (throws) rather than loadEnv (process.exit) so a config error flows through
  // the guard below and becomes one sanitized RESULT: FAIL line, never a raw dump.
  loadEnv: () => parseEnv(),
  createLogger: (env) => createLogger(env, { service: 'cli' }),
  createCipher: (env, logger) => createCredentialCipher(env, { logger }),
  createDatabase: (env, logger) => createDatabase(env, logger, { service: 'cli' }),
  runSmoke: realRunSmoke,
};

export interface GithubSmokeCliIo {
  readonly argv: readonly string[];
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
}
/**
 * Run the CLI end to end and return its exit code (never throws). Validates both ids as
 * UUIDs before anything else — so no database or production access happens without two
 * well-formed args (the CLI cannot silently run a production test by accident). Every
 * stage runs inside one guard that emits only a typed, non-secret code + one sanitized
 * RESULT line; the database handle, once opened, is always closed.
 */
export async function runCli(io: GithubSmokeCliIo, deps: GithubSmokeCliDeps = DEFAULT_DEPS): Promise<0 | 1> {
  const tenantId = io.argv[0];
  const connectionId = io.argv[1];
  if (!isValidId(tenantId) || !isValidId(connectionId)) {
    io.stderr.write('usage: pnpm github:get-user-smoke <tenantId:uuid> <connectionId:uuid>\n');
    return 1;
  }

  const runSmoke = deps.runSmoke ?? realRunSmoke;
  let database: DatabaseHandle | undefined;
  let logger: Logger | undefined;
  try {
    const env = deps.loadEnv();
    logger = deps.createLogger(env);
    const cipher = deps.createCipher(env, logger);
    if (!cipher.hasKey) {
      io.stdout.write(
        'RESULT: FAIL — no credential encryption key is configured, so the stored GitHub token cannot be decrypted.\n',
      );
      return 1;
    }
    database = deps.createDatabase(env, logger);
    await database.verifyConnection();
    const verdict = await runSmoke({ env, logger, cipher, database, tenantId, connectionId, stdout: io.stdout });
    return verdict.exitCode;
  } catch (error) {
    if (logger !== undefined) {
      logger.error(
        { event: 'github_get_user_smoke_error', code: isAppError(error) ? error.code : 'unknown' },
        'github_get_user_smoke_error',
      );
    }
    io.stdout.write('RESULT: FAIL — the smoke test could not run (see run logs for a non-secret error code).\n');
    return 1;
  } finally {
    if (database !== undefined) {
      try {
        await database.close();
      } catch {
        // A cleanup failure must neither replace the verdict nor leak a raw detail.
      }
    }
  }
}

async function main(): Promise<void> {
  // LOG_LEVEL is expected to be `silent` for a clean single-line result.
  process.exitCode = await runCli({ argv: process.argv.slice(2), stdout: process.stdout, stderr: process.stderr });
}

// Run `main` only when executed directly, so tests import the pure helpers above without
// triggering env loading, a database connection, or any production access.
const invokedPath = process.argv[1];
const isEntrypoint = invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href;
if (isEntrypoint) {
  await main();
}
