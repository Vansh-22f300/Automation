/**
 * GitHub connector unit tests — with a fake transport, never the real GitHub API.
 *
 * These prove each connector's contract: it calls exactly the right fixed endpoint,
 * the access token reaches ONLY the transport (never the result, logs, or a
 * normalized error), the small success shape is returned, and every GitHub failure
 * maps onto the right taxonomy (permanent vs retryable) with the correct effect-safety
 * tag — a rate-limit rejection is safe to resend, a 5xx/transport failure on a
 * mutation is ambiguous and must be held.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  GithubCreateIssueConnector,
  GithubUserConnector,
} from '@/connectors/github/github-connector.js';
import type {
  GithubCreateIssueArgs,
  GithubGetUserArgs,
} from '@/connectors/github/github-connector.js';
import type { AuthorizedConnection } from '@/domain/connection.js';
import { PermanentError, RetryableError } from '@/domain/errors.js';
import type { ConnectorRequest, ToolContext } from '@/domain/tool.js';
import { FakeGithubTransport } from '@/test/support/fake-github-transport.js';

const ACCESS_TOKEN = 'gho_UNIT_TEST_SECRET_TOKEN';
const CONTEXT: ToolContext = { tenantId: 't1', runId: 'r1', stepRunId: 's1', toolName: 'github_tool' };

function connection(credential: Record<string, unknown> = { accessToken: ACCESS_TOKEN, tokenType: 'bearer' }): AuthorizedConnection {
  return {
    metadata: {
      id: 'conn-gh-1',
      provider: 'github',
      name: 'octocat',
      status: 'active',
      metadata: {},
      createdAt: new Date(0),
      updatedAt: new Date(0),
      lastUsedAt: null,
    },
    credential,
  };
}

function userRequest(cred?: Record<string, unknown>): ConnectorRequest<GithubGetUserArgs> {
  return { context: CONTEXT, arguments: {}, connection: connection(cred) };
}

function issueRequest(args: GithubCreateIssueArgs, cred?: Record<string, unknown>): ConnectorRequest<GithubCreateIssueArgs> {
  return { context: CONTEXT, arguments: args, connection: connection(cred) };
}

const ISSUE_ARGS: GithubCreateIssueArgs = { owner: 'octocat', repo: 'hello-world', title: 'Found a bug', body: 'details' };

describe('GithubUserConnector', () => {
  it('returns the normalized identity and sends the token only to the transport', async () => {
    const transport = new FakeGithubTransport();
    const result = await new GithubUserConnector({ transport }).execute(userRequest());
    expect(transport.userCalls).toBe(1);
    expect(transport.lastToken).toBe(ACCESS_TOKEN);
    expect(result).toEqual({ id: 42, login: 'octocat', name: 'The Octocat' });
    expect(JSON.stringify(result)).not.toContain(ACCESS_TOKEN);
  });

  it('never logs the access token', async () => {
    const info = vi.fn();
    const warn = vi.fn();
    const logger = { info, warn, error: vi.fn(), debug: vi.fn(), child: vi.fn() } as never;
    await new GithubUserConnector({ transport: new FakeGithubTransport(), logger }).execute(userRequest());
    expect(JSON.stringify(info.mock.calls.concat(warn.mock.calls))).not.toContain(ACCESS_TOKEN);
  });

  it('rejects a credential without an access token (permanent, token never echoed)', async () => {
    const e = await new GithubUserConnector({ transport: new FakeGithubTransport() })
      .execute(userRequest({ tokenType: 'bearer' }))
      .then(() => undefined, (err: unknown) => err);
    expect(e).toBeInstanceOf(PermanentError);
    expect((e as PermanentError).code).toBe('github_credential_invalid');
  });

  it('maps a malformed identity body to a permanent error', async () => {
    const transport = new FakeGithubTransport({ userResponse: { status: 200, body: { login: 'no-id' } } });
    const e = await new GithubUserConnector({ transport }).execute(userRequest()).then(() => undefined, (err: unknown) => err);
    expect(e).toBeInstanceOf(PermanentError);
    expect((e as PermanentError).code).toBe('github_malformed_response');
  });

  it('maps HTTP 401 to a permanent error', async () => {
    const transport = new FakeGithubTransport({ userResponse: { status: 401, body: { message: 'Bad credentials' } } });
    const e = await new GithubUserConnector({ transport }).execute(userRequest()).then(() => undefined, (err: unknown) => err);
    expect(e).toBeInstanceOf(PermanentError);
    expect((e as PermanentError).code).toBe('github_unauthorized');
  });

  it('maps a 5xx on a read to retryable + effect-SAFE (a GET has no external effect)', async () => {
    const transport = new FakeGithubTransport({ userResponse: { status: 503, body: {} } });
    const e = await new GithubUserConnector({ transport }).execute(userRequest()).then(() => undefined, (err: unknown) => err);
    expect(e).toBeInstanceOf(RetryableError);
    expect((e as RetryableError).details).toEqual({ status: 503, effectSafety: 'safe' });
  });

  it('maps a transport failure on a read to retryable + effect-SAFE', async () => {
    const transport = new FakeGithubTransport({ throwOnUser: new Error('aborted') });
    const e = await new GithubUserConnector({ transport }).execute(userRequest()).then(() => undefined, (err: unknown) => err);
    expect(e).toBeInstanceOf(RetryableError);
    expect((e as RetryableError).code).toBe('github_network_error');
    expect((e as RetryableError).details).toEqual({ effectSafety: 'safe' });
  });
});

describe('GithubCreateIssueConnector', () => {
  const run = (transport: FakeGithubTransport, args = ISSUE_ARGS) =>
    new GithubCreateIssueConnector({ transport }).execute(issueRequest(args)).then(() => undefined, (e: unknown) => e);

  it('declares a hold_ambiguous recovery policy (create is not idempotent)', () => {
    expect(new GithubCreateIssueConnector({ transport: new FakeGithubTransport() }).recoveryPolicy).toBe('hold_ambiguous');
  });

  it('posts the exact owner/repo/title/body and returns a small non-secret result', async () => {
    const transport = new FakeGithubTransport();
    const result = await new GithubCreateIssueConnector({ transport }).execute(issueRequest(ISSUE_ARGS));
    expect(transport.issueCalls).toBe(1);
    expect(transport.lastIssueInput).toEqual({ owner: 'octocat', repo: 'hello-world', title: 'Found a bug', body: 'details' });
    expect(transport.lastToken).toBe(ACCESS_TOKEN);
    expect(result).toEqual({ ok: true, number: 7, id: 1001, url: 'https://github.com/octocat/hello-world/issues/7', state: 'open', title: 'Found a bug' });
    expect(JSON.stringify(result)).not.toContain(ACCESS_TOKEN);
  });

  it('maps HTTP 422 (validation) to a permanent error', async () => {
    const e = await run(new FakeGithubTransport({ issueResponse: { status: 422, body: { message: 'Validation Failed' } } }));
    expect(e).toBeInstanceOf(PermanentError);
    expect((e as PermanentError).code).toBe('github_unprocessable');
  });

  it('maps HTTP 429 to retryable + effect-SAFE (rejected before the issue was created)', async () => {
    const e = await run(new FakeGithubTransport({ issueResponse: { status: 429, retryAfterSeconds: 60, body: {} } }));
    expect(e).toBeInstanceOf(RetryableError);
    expect((e as RetryableError).code).toBe('github_rate_limited');
    expect((e as RetryableError).details).toEqual({ status: 429, retryAfterSeconds: 60, effectSafety: 'safe' });
  });

  it('treats a 403 with Retry-After as a (safe) secondary rate limit', async () => {
    const e = await run(new FakeGithubTransport({ issueResponse: { status: 403, retryAfterSeconds: 30, body: {} } }));
    expect(e).toBeInstanceOf(RetryableError);
    expect((e as RetryableError).code).toBe('github_rate_limited');
    expect((e as RetryableError).details).toEqual({ status: 403, retryAfterSeconds: 30, effectSafety: 'safe' });
  });

  it('treats a 403 with no rate-limit signal as a permanent forbidden', async () => {
    const e = await run(new FakeGithubTransport({ issueResponse: { status: 403, body: { message: 'Resource not accessible' } } }));
    expect(e).toBeInstanceOf(PermanentError);
    expect((e as PermanentError).code).toBe('github_forbidden');
  });

  it('maps a 5xx on a mutation to retryable + effect-AMBIGUOUS (the issue may exist)', async () => {
    const e = await run(new FakeGithubTransport({ issueResponse: { status: 502, body: {} } }));
    expect(e).toBeInstanceOf(RetryableError);
    expect((e as RetryableError).code).toBe('github_http_5xx');
    expect((e as RetryableError).details).toEqual({ status: 502, effectSafety: 'ambiguous' });
  });

  it('maps a transport failure on a mutation to retryable + effect-AMBIGUOUS', async () => {
    const e = await run(new FakeGithubTransport({ throwOnIssue: new Error('socket hang up') }));
    expect(e).toBeInstanceOf(RetryableError);
    expect((e as RetryableError).code).toBe('github_network_error');
    expect((e as RetryableError).details).toEqual({ effectSafety: 'ambiguous' });
    expect(JSON.stringify((e as RetryableError).message)).not.toContain(ACCESS_TOKEN);
  });
});
