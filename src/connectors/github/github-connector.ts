/**
 * The GitHub connectors: two provider-neutral {@link Connector}s over the confined
 * {@link GithubTransport}. One reads the authenticated identity (`GET /user`), one
 * creates an issue (`POST /repos/{owner}/{repo}/issues`). Each receives only what a
 * connector is given — a least-privilege {@link ToolContext}, validated arguments,
 * and the resolved {@link AuthorizedConnection} whose decrypted credential carries a
 * fresh `accessToken` (the refreshing resolver has already rotated it if needed).
 *
 * The access token flows from `connection.credential.accessToken` into the transport
 * and nowhere else: never returned, never logged, never placed in an error. Logging
 * is metadata-only. Failures are mapped onto the shared `RetryableError`/
 * `PermanentError` taxonomy with an effect-safety tag so the effect ledger can tell a
 * rate-limit rejection (the write did not happen → safe to resend) from a 5xx/network
 * failure (the write may have happened → hold).
 */

import { PermanentError, RetryableError } from '@/domain/errors.js';
import { EFFECT_SAFETY_DETAIL_KEY } from '@/domain/tool.js';
import type { Connector, ConnectorRequest, EffectRecoveryPolicy, ToolContext } from '@/domain/tool.js';
import { GITHUB_PROVIDER } from '@/oauth/providers/index.js';
import type { Logger } from '@/observability/logger.js';

import type { GithubHttpResponse, GithubTransport } from './github-client.js';
import { parseGithubIdentity } from './github-identity.js';
import type { GithubIdentity } from './github-identity.js';

/** `github_get_authenticated_user` takes no arguments — the connection is trusted config. */
export type GithubGetUserArgs = Record<string, never>;

/** The validated `github_create_issue` argument shape (mirrors the tool's Zod schema). */
export interface GithubCreateIssueArgs {
  readonly owner: string;
  readonly repo: string;
  readonly title: string;
  // `string | undefined` (not just optional) to match the Zod `.optional()` output
  // exactly under `exactOptionalPropertyTypes`, so the schema binds without a cast.
  readonly body?: string | undefined;
}

/** The small, non-secret create-issue success shape stored for workflow continuation. */
export interface GithubIssueResult {
  readonly ok: true;
  readonly number?: number;
  readonly id?: number;
  readonly url?: string;
  readonly state?: string;
  readonly title?: string;
}

/** The single effect-safety detail entry a connector attaches to a raised error. */
type EffectSafetyDetail = { readonly [EFFECT_SAFETY_DETAIL_KEY]: 'safe' | 'ambiguous' };
const SAFE: EffectSafetyDetail = { [EFFECT_SAFETY_DETAIL_KEY]: 'safe' };
const AMBIGUOUS: EffectSafetyDetail = { [EFFECT_SAFETY_DETAIL_KEY]: 'ambiguous' };

/** Pull the access token from the decrypted credential; a missing one is config error. */
function extractAccessToken(credential: Record<string, unknown>): string {
  const token = credential['accessToken'];
  if (typeof token !== 'string' || token.length === 0) {
    // Deterministic misconfiguration — not retryable. The value is never included.
    throw new PermanentError(
      'github_credential_invalid',
      'GitHub connection credential is missing a valid access token',
    );
  }
  return token;
}

/**
 * Map a GitHub HTTP outcome onto the error taxonomy; `undefined` on 2xx success.
 * `effectful` is true for a mutating call (create issue), where a 5xx/transport
 * failure is AMBIGUOUS (the write may have landed); a GET is always effect-SAFE.
 * A rate-limit (429, or 403 with a Retry-After / exhausted remaining) is SAFE even
 * for a mutation: GitHub rejected the request before it was processed.
 */
function classifyGithubResponse(
  response: GithubHttpResponse,
  effectful: boolean,
): PermanentError | RetryableError | undefined {
  const { status, retryAfterSeconds, rateLimitRemaining } = response;
  if (status >= 200 && status < 300) return undefined;

  const rateLimited =
    status === 429 || (status === 403 && (retryAfterSeconds !== undefined || rateLimitRemaining === 0));
  if (rateLimited) {
    return new RetryableError('github_rate_limited', 'GitHub rate-limited the request', {
      details: { status, ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}), ...SAFE },
    });
  }
  if (status >= 500) {
    return new RetryableError('github_http_5xx', `GitHub returned HTTP ${status}`, {
      details: { status, ...(effectful ? AMBIGUOUS : SAFE) },
    });
  }
  if (status === 401) {
    return new PermanentError('github_unauthorized', 'GitHub rejected the access token', { details: { status } });
  }
  if (status === 403) {
    return new PermanentError('github_forbidden', 'GitHub denied access to the requested resource', { details: { status } });
  }
  if (status === 404) {
    return new PermanentError('github_not_found', 'the requested GitHub resource was not found', { details: { status } });
  }
  if (status === 422) {
    return new PermanentError('github_unprocessable', 'GitHub could not process the request', { details: { status } });
  }
  return new PermanentError('github_http_error', `GitHub returned HTTP ${status}`, { details: { status } });
}

/** A transport-level failure (network/DNS/timeout/abort). Retryable; safety per op. */
function githubNetworkError(cause: unknown, effectful: boolean): RetryableError {
  return new RetryableError('github_network_error', 'GitHub request failed at the transport layer', {
    cause,
    details: { ...(effectful ? AMBIGUOUS : SAFE) },
  });
}

/** Defensively project a created-issue body; never throws (the issue already exists). */
function parseGithubIssue(body: unknown): GithubIssueResult {
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  return {
    ok: true,
    ...(typeof b['number'] === 'number' ? { number: b['number'] } : {}),
    ...(typeof b['id'] === 'number' ? { id: b['id'] } : {}),
    ...(typeof b['html_url'] === 'string' ? { url: b['html_url'] } : {}),
    ...(typeof b['state'] === 'string' ? { state: b['state'] } : {}),
    ...(typeof b['title'] === 'string' ? { title: b['title'] } : {}),
  };
}

/** The metadata-only log base both connectors share. Never carries a secret. */
function logBase(context: ToolContext, connectionId: string): Record<string, unknown> {
  return {
    tenant_id: context.tenantId,
    ...(context.runId !== undefined ? { run_id: context.runId } : {}),
    ...(context.stepRunId !== undefined ? { step_run_id: context.stepRunId } : {}),
    tool: context.toolName,
    provider: GITHUB_PROVIDER,
    connection_id: connectionId,
  };
}

export interface GithubConnectorOptions {
  readonly transport: GithubTransport;
  /** Metadata-only logger. The connector binds no secrets to it. */
  readonly logger?: Logger;
}

/**
 * `github_get_authenticated_user`: returns the connected account's normalized
 * identity. A read with no external effect, so every failure is effect-safe and
 * released for a genuine retry — `recoveryPolicy` is left at the `hold_ambiguous`
 * default but is never consulted for this connector.
 */
export class GithubUserConnector implements Connector<GithubGetUserArgs> {
  readonly provider = GITHUB_PROVIDER;

  private readonly transport: GithubTransport;
  private readonly logger: Logger | undefined;

  constructor(options: GithubConnectorOptions) {
    this.transport = options.transport;
    this.logger = options.logger;
  }

  async execute(request: ConnectorRequest<GithubGetUserArgs>): Promise<GithubIdentity> {
    const { context, connection } = request;
    const startedAt = Date.now();
    const base = logBase(context, connection.metadata.id);
    this.logger?.info(base, 'github_tool_started');

    const accessToken = extractAccessToken(connection.credential);
    let response: GithubHttpResponse;
    try {
      response = await this.transport.getAuthenticatedUser(accessToken);
    } catch (cause) {
      const error = githubNetworkError(cause, false);
      this.logger?.warn({ ...base, error_code: error.code }, 'github_tool_failed');
      throw error;
    }

    const failure = classifyGithubResponse(response, false);
    if (failure !== undefined) {
      this.logger?.warn({ ...base, error_code: failure.code }, 'github_tool_failed');
      throw failure;
    }

    const identity = parseGithubIdentity(response.body);
    if (identity === undefined) {
      const error = new PermanentError(
        'github_malformed_response',
        'GitHub returned an unexpected identity response',
      );
      this.logger?.warn({ ...base, error_code: error.code }, 'github_tool_failed');
      throw error;
    }

    this.logger?.info(
      { ...base, latency_ms: Date.now() - startedAt, github_user_id: identity.id },
      'github_tool_succeeded',
    );
    return identity;
  }
}

/**
 * `github_create_issue`: opens an issue on a public repository. A non-idempotent
 * mutation, so `recoveryPolicy = 'hold_ambiguous'` — an unknown outcome (5xx /
 * transport failure after the request left) is held and surfaced, never resent,
 * so a redelivered job can never post a duplicate issue.
 */
export class GithubCreateIssueConnector implements Connector<GithubCreateIssueArgs> {
  readonly provider = GITHUB_PROVIDER;
  readonly recoveryPolicy: EffectRecoveryPolicy = 'hold_ambiguous';

  private readonly transport: GithubTransport;
  private readonly logger: Logger | undefined;

  constructor(options: GithubConnectorOptions) {
    this.transport = options.transport;
    this.logger = options.logger;
  }

  async execute(request: ConnectorRequest<GithubCreateIssueArgs>): Promise<GithubIssueResult> {
    const { context, arguments: args, connection } = request;
    const startedAt = Date.now();
    const base = { ...logBase(context, connection.metadata.id), owner: args.owner, repo: args.repo };
    this.logger?.info(base, 'github_tool_started');

    const accessToken = extractAccessToken(connection.credential);
    let response: GithubHttpResponse;
    try {
      response = await this.transport.createIssue(
        {
          owner: args.owner,
          repo: args.repo,
          title: args.title,
          ...(args.body !== undefined ? { body: args.body } : {}),
        },
        accessToken,
      );
    } catch (cause) {
      const error = githubNetworkError(cause, true);
      this.logger?.warn({ ...base, error_code: error.code }, 'github_tool_failed');
      throw error;
    }

    const failure = classifyGithubResponse(response, true);
    if (failure !== undefined) {
      this.logger?.warn({ ...base, error_code: failure.code }, 'github_tool_failed');
      throw failure;
    }

    const result = parseGithubIssue(response.body);
    this.logger?.info(
      { ...base, latency_ms: Date.now() - startedAt, ...(result.number !== undefined ? { issue_number: result.number } : {}) },
      'github_tool_succeeded',
    );
    return result;
  }
}
