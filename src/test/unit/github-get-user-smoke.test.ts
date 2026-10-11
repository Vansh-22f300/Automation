/**
 * Offline unit tests for the `github-get-user-smoke` CLI. No real GitHub API and no real
 * database: a fake GitHub transport, a fake connection resolver, and injected CLI deps.
 * They prove the diagnostic runs ONLY github_get_authenticated_user through the real
 * ToolExecutor, classifies GitHub/credential failures safely, never prints a token or
 * credential, wires no effect-ledger/workflow/job/LLM, validates its ids, and always
 * closes the database.
 */
import { Writable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import {
  buildDiagnosticRegistry,
  createQuietCliLogger,
  GITHUB_SMOKE_TOOL,
  isValidId,
  runCli,
  runGithubGetUserSmoke,
  type GithubSmokeCliDeps,
  type ToolExecutorLike,
} from '@/cli/github-get-user-smoke.js';
import { parseEnv } from '@/config/env.js';
import type { ConnectionMetadata, ConnectionRef, ConnectionResolver } from '@/domain/connection.js';
import type { ToolCall } from '@/domain/tool.js';
import { ToolExecutor } from '@/domain/tool-executor.js';
import { GITHUB_PROVIDER } from '@/oauth/providers/index.js';
import { FakeGithubTransport } from '@/test/support/fake-github-transport.js';
import { PermanentError } from '@/domain/errors.js';
import { OAuthProviderError } from '@/oauth/errors.js';
import { RefreshingConnectionResolver } from '@/oauth/refreshing-connection-resolver.js';
import type { RefreshableConnectionStore } from '@/oauth/refreshing-connection-resolver.js';
import type { AccessTokenResult, TokenSource } from '@/oauth/token-source.js';
import type { OAuthTokenSet } from '@/oauth/token-client.js';
import type { AuthorizedConnectionWithEnvelope, CredentialSwapOutcome } from '@/repositories/connection-repository.js';
import type { Logger } from '@/observability/logger.js';

const TID = '018f0000-0000-7000-8000-000000000001';
const CID = '018f0000-0000-7000-8000-0000000000c0';
const SENTINEL = 'ghp_SENTINEL_TOKEN_MUST_NOT_PRINT';

function collect(): { stream: NodeJS.WritableStream; text: () => string } {
  let buf = '';
  const stream = new Writable({ write(chunk, _enc, cb) { buf += String(chunk); cb(); } });
  return { stream, text: () => buf };
}

function githubMeta(status: ConnectionMetadata['status']): ConnectionMetadata {
  return {
    id: CID, provider: 'github', name: 'octocat', status, metadata: {},
    createdAt: new Date(0), updatedAt: new Date(0), lastUsedAt: null,
  };
}

/** A fake resolver yielding a known credential (sentinel token lets a leak be detected). */
function fakeResolver(
  credential: Record<string, unknown> = { accessToken: SENTINEL, tokenType: 'bearer' },
): ConnectionResolver {
  return { resolveForTool: async (_ref: ConnectionRef) => ({ metadata: githubMeta('active'), credential }) };
}

function realExecutor(transport: FakeGithubTransport, resolver: ConnectionResolver = fakeResolver()): ToolExecutor {
  return new ToolExecutor(buildDiagnosticRegistry(transport), resolver);
}
describe('runGithubGetUserSmoke — success', () => {
  it('PASSes and prints the login, never the token', async () => {
    const transport = new FakeGithubTransport({ userResponse: { status: 200, body: { id: 42, login: 'Vansh-22f300', name: 'Vansh' } } });
    const out = collect();
    const v = await runGithubGetUserSmoke({ executor: realExecutor(transport), getMetadata: async () => githubMeta('active'), tenantId: TID, connectionId: CID, stdout: out.stream });
    expect(v).toMatchObject({ outcome: 'pass', reason: 'ok', login: 'Vansh-22f300', exitCode: 0 });
    expect(out.text()).toContain('PASS');
    expect(out.text()).toContain('Vansh-22f300');
    expect(out.text()).not.toContain(SENTINEL);
    expect(transport.userCalls).toBe(1);
    expect(transport.issueCalls).toBe(0);
  });
});

describe('runGithubGetUserSmoke — connection pre-checks (executor never runs)', () => {
  const neverExecutor: ToolExecutorLike = { execute: async () => { throw new Error('executor must not run'); } };
  it('FAILs connection_not_found when metadata is null', async () => {
    const v = await runGithubGetUserSmoke({ executor: neverExecutor, getMetadata: async () => null, tenantId: TID, connectionId: CID, stdout: collect().stream });
    expect(v).toMatchObject({ outcome: 'fail', reason: 'connection_not_found', exitCode: 1 });
  });
  it('FAILs wrong_provider for a non-github connection', async () => {
    const v = await runGithubGetUserSmoke({ executor: neverExecutor, getMetadata: async () => ({ ...githubMeta('active'), provider: 'slack' }), tenantId: TID, connectionId: CID, stdout: collect().stream });
    expect(v).toMatchObject({ outcome: 'fail', reason: 'wrong_provider' });
  });
  it('FAILs connection_not_active for a disabled connection', async () => {
    const v = await runGithubGetUserSmoke({ executor: neverExecutor, getMetadata: async () => githubMeta('disabled'), tenantId: TID, connectionId: CID, stdout: collect().stream });
    expect(v).toMatchObject({ outcome: 'fail', reason: 'connection_not_active' });
  });
});
describe('runGithubGetUserSmoke — failures are classified and sanitized', () => {
  it.each([
    [401, 'github_unauthorized'],
    [403, 'github_forbidden'],
    [429, 'github_rate_limited'],
    [500, 'github_http_5xx'],
  ] as const)('maps HTTP %i to [%s] without leaking the token', async (status, code) => {
    const transport = new FakeGithubTransport({ userResponse: { status, body: {} } });
    const out = collect();
    const v = await runGithubGetUserSmoke({ executor: realExecutor(transport), getMetadata: async () => githubMeta('active'), tenantId: TID, connectionId: CID, stdout: out.stream });
    expect(v).toMatchObject({ outcome: 'fail', reason: 'tool_failed', errorCode: code, exitCode: 1 });
    expect(out.text()).toContain('FAIL');
    expect(out.text()).not.toContain(SENTINEL);
  });

  it('FAILs github_credential_invalid when the stored credential has no access token', async () => {
    const transport = new FakeGithubTransport();
    const v = await runGithubGetUserSmoke({ executor: realExecutor(transport, fakeResolver({ tokenType: 'bearer' })), getMetadata: async () => githubMeta('active'), tenantId: TID, connectionId: CID, stdout: collect().stream });
    expect(v).toMatchObject({ outcome: 'fail', reason: 'tool_failed', errorCode: 'github_credential_invalid' });
    expect(transport.userCalls).toBe(0); // never reached the GitHub call
  });
});

describe('diagnostic registry — only the read tool is registered', () => {
  it('has github_get_authenticated_user and NOT github_create_issue', () => {
    const reg = buildDiagnosticRegistry(new FakeGithubTransport());
    expect(reg.has(GITHUB_SMOKE_TOOL)).toBe(true);
    expect(reg.has('github_create_issue')).toBe(false);
    expect(() => reg.resolve('github_create_issue')).toThrow();
  });
});

describe('runGithubGetUserSmoke — invokes exactly one unledgered tool call', () => {
  it('calls execute once with {} args, trusted connectionRef, and no run/step wiring', async () => {
    let calls = 0;
    let captured: { call: ToolCall; options: { context: { tenantId: string; runId?: string; stepRunId?: string }; connectionRef?: ConnectionRef } } | undefined;
    const fake: ToolExecutorLike = {
      execute: async (call, options) => {
        calls += 1;
        captured = { call, options };
        return { id: call.id, name: call.name, success: true, output: { id: 1, login: 'Vansh-22f300' } };
      },
    };
    await runGithubGetUserSmoke({ executor: fake, getMetadata: async () => githubMeta('active'), tenantId: TID, connectionId: CID, stdout: collect().stream });
    expect(calls).toBe(1);
    expect(captured?.call.name).toBe('github_get_authenticated_user');
    expect(captured?.call.arguments).toEqual({});
    expect(captured?.options.connectionRef).toEqual({ provider: GITHUB_PROVIDER, connectionId: CID });
    expect(captured?.options.context.tenantId).toBe(TID);
    expect(captured?.options.context.runId).toBeUndefined();
    expect(captured?.options.context.stepRunId).toBeUndefined();
  });
});
const fakeEnv = {} as never;
const fakeLogger = { error: vi.fn() } as never;
function fakeDb(close = vi.fn(async () => undefined)) {
  return { db: {}, verifyConnection: vi.fn(async () => undefined), close } as never;
}

describe('runCli — argument validation and no accidental production access', () => {
  it('rejects non-UUID args, returns 1, and never opens a database', async () => {
    const createDatabase = vi.fn();
    const code = await runCli(
      { argv: ['not-a-uuid', 'nope'], stdout: collect().stream, stderr: collect().stream },
      { loadEnv: vi.fn(), createLogger: vi.fn(), createCipher: vi.fn(), createDatabase, runSmoke: vi.fn() } as unknown as GithubSmokeCliDeps,
    );
    expect(code).toBe(1);
    expect(createDatabase).not.toHaveBeenCalled();
  });

  it('FAILs without opening a database when no credential key is configured', async () => {
    const createDatabase = vi.fn();
    const out = collect();
    const code = await runCli(
      { argv: [TID, CID], stdout: out.stream, stderr: collect().stream },
      { loadEnv: () => fakeEnv, createLogger: () => fakeLogger, createCipher: () => ({ hasKey: false } as never), createDatabase, runSmoke: vi.fn() },
    );
    expect(code).toBe(1);
    expect(createDatabase).not.toHaveBeenCalled();
    expect(out.text()).toContain('FAIL');
  });
});

describe('runCli — always closes the database', () => {
  it('closes on success', async () => {
    const close = vi.fn(async () => undefined);
    const code = await runCli(
      { argv: [TID, CID], stdout: collect().stream, stderr: collect().stream },
      { loadEnv: () => fakeEnv, createLogger: () => fakeLogger, createCipher: () => ({ hasKey: true } as never), createDatabase: () => fakeDb(close), runSmoke: async () => ({ outcome: 'pass', reason: 'ok', login: 'x', exitCode: 0 }) },
    );
    expect(code).toBe(0);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('closes on failure and reports a sanitized FAIL (no raw exception)', async () => {
    const close = vi.fn(async () => undefined);
    const out = collect();
    const code = await runCli(
      { argv: [TID, CID], stdout: out.stream, stderr: collect().stream },
      { loadEnv: () => fakeEnv, createLogger: () => fakeLogger, createCipher: () => ({ hasKey: true } as never), createDatabase: () => fakeDb(close), runSmoke: async () => { throw new Error('boom-raw-detail'); } },
    );
    expect(code).toBe(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(out.text()).toContain('FAIL');
    expect(out.text()).not.toContain('boom-raw-detail');
  });
});

// --- Real RefreshingConnectionResolver (fake store + fake token source) ---------------
// These prove the CLI runs the REAL resolver, and that a SUCCESSFUL resolution is NOT
// database-read-only: a refresh persists the rotated credential via compare-and-swap.
const ENVELOPE = { v: 1, alg: 'aes-256-gcm', iv: 'IV', ct: 'CT-OLD', tag: 'TAG' } as const;
function resolution(credential: Record<string, unknown>): AuthorizedConnectionWithEnvelope {
  return { metadata: githubMeta('active'), credential, encryptedCredentials: { ...ENVELOPE } };
}
function makeStore(resolved: AuthorizedConnectionWithEnvelope, swap: CredentialSwapOutcome) {
  const compareAndSwapCredential = vi.fn(async () => swap);
  const store: RefreshableConnectionStore = { resolveWithEnvelope: vi.fn(async () => resolved), compareAndSwapCredential };
  return { store, compareAndSwapCredential };
}
function tokenSourceOf(result: AccessTokenResult): TokenSource {
  return { getAccessToken: vi.fn(async () => result) };
}
function realResolverExecutor(transport: FakeGithubTransport, store: RefreshableConnectionStore, tokenSource: TokenSource): ToolExecutor {
  return new ToolExecutor(buildDiagnosticRegistry(transport), new RefreshingConnectionResolver(store, tokenSource));
}
const okUser = { status: 200, body: { id: 42, login: 'Vansh-22f300', name: 'Vansh' } } as const;

describe('runGithubGetUserSmoke — real resolver: a valid token is passed through (no write-back)', () => {
  it('uses the stored token and never calls compare-and-swap', async () => {
    const transport = new FakeGithubTransport({ userResponse: { ...okUser } });
    const { store, compareAndSwapCredential } = makeStore(
      resolution({ accessToken: 'valid-at', tokenType: 'bearer', expiresAt: '2999-01-01T00:00:00.000Z' }),
      { status: 'applied', credential: {}, encryptedCredentials: { ...ENVELOPE, ct: 'CT-NEW' } },
    );
    const executor = realResolverExecutor(transport, store, tokenSourceOf({ accessToken: 'valid-at', tokenType: 'bearer' }));
    const v = await runGithubGetUserSmoke({ executor, getMetadata: async () => githubMeta('active'), tenantId: TID, connectionId: CID, stdout: collect().stream });
    expect(v.outcome).toBe('pass');
    expect(transport.lastToken).toBe('valid-at');
    expect(compareAndSwapCredential).not.toHaveBeenCalled();
  });
});
describe('runGithubGetUserSmoke — real resolver: a refresh persists the rotated credential', () => {
  const refreshedSet: OAuthTokenSet = { accessToken: 'new-at', tokenType: 'bearer', refreshToken: 'new-rt' };
  const expiredCred = { accessToken: 'old-at', tokenType: 'bearer', refreshToken: 'old-rt', expiresAt: '2000-01-01T00:00:00.000Z' };

  it('writes via compare-and-swap and uses the NEW token (resolution is NOT read-only)', async () => {
    const transport = new FakeGithubTransport({ userResponse: { ...okUser } });
    const { store, compareAndSwapCredential } = makeStore(resolution(expiredCred), { status: 'applied', credential: {}, encryptedCredentials: { ...ENVELOPE, ct: 'CT-NEW' } });
    const executor = realResolverExecutor(transport, store, tokenSourceOf({ accessToken: 'new-at', tokenType: 'bearer', refreshed: refreshedSet }));
    const v = await runGithubGetUserSmoke({ executor, getMetadata: async () => githubMeta('active'), tenantId: TID, connectionId: CID, stdout: collect().stream });
    expect(v.outcome).toBe('pass');
    expect(compareAndSwapCredential).toHaveBeenCalledTimes(1); // a persistence WRITE happened
    expect(transport.lastToken).toBe('new-at'); // the fresh token reached GitHub
  });

  it('adopts the winner credential when a concurrent writer rotated first (superseded)', async () => {
    const transport = new FakeGithubTransport({ userResponse: { ...okUser } });
    const winner = { accessToken: 'winner-at', tokenType: 'bearer', refreshToken: 'winner-rt' };
    const { store } = makeStore(resolution(expiredCred), { status: 'superseded', credential: winner, encryptedCredentials: { ...ENVELOPE, ct: 'CT-WINNER' } });
    const executor = realResolverExecutor(transport, store, tokenSourceOf({ accessToken: 'new-at', tokenType: 'bearer', refreshed: refreshedSet }));
    const v = await runGithubGetUserSmoke({ executor, getMetadata: async () => githubMeta('active'), tenantId: TID, connectionId: CID, stdout: collect().stream });
    expect(v.outcome).toBe('pass');
    expect(transport.lastToken).toBe('winner-at'); // adopted the winner, never the stale token
  });
});

describe('runGithubGetUserSmoke — real resolver: a rejected refresh fails safely', () => {
  it('surfaces OAuthProviderError sanitized, with no write and no stale GitHub call', async () => {
    const transport = new FakeGithubTransport({ userResponse: { ...okUser } });
    const compareAndSwapCredential = vi.fn();
    const store: RefreshableConnectionStore = {
      resolveWithEnvelope: vi.fn(async () => resolution({ accessToken: 'old-at', tokenType: 'bearer', refreshToken: 'dead', expiresAt: '2000-01-01T00:00:00.000Z' })),
      compareAndSwapCredential,
    };
    const tokenSource: TokenSource = { getAccessToken: vi.fn(async () => { throw new OAuthProviderError('refresh token expired', 'not_refreshable'); }) };
    const out = collect();
    const v = await runGithubGetUserSmoke({ executor: realResolverExecutor(transport, store, tokenSource), getMetadata: async () => githubMeta('active'), tenantId: TID, connectionId: CID, stdout: out.stream });
    expect(v).toMatchObject({ outcome: 'fail', reason: 'tool_failed', errorCode: 'oauth_provider_error' });
    expect(compareAndSwapCredential).not.toHaveBeenCalled();
    expect(transport.userCalls).toBe(0);
    expect(out.text()).not.toContain('old-at');
    expect(out.text()).not.toContain('dead');
  });
});
describe('runGithubGetUserSmoke — transport edge cases', () => {
  it('maps a transport timeout/network error to [github_network_error] with one attempt', async () => {
    const transport = new FakeGithubTransport({ throwOnUser: new Error('ETIMEDOUT') });
    const v = await runGithubGetUserSmoke({ executor: realExecutor(transport), getMetadata: async () => githubMeta('active'), tenantId: TID, connectionId: CID, stdout: collect().stream });
    expect(v).toMatchObject({ outcome: 'fail', errorCode: 'github_network_error' });
    expect(transport.userCalls).toBe(1); // one attempt, no unsafe retry loop
    expect(transport.issueCalls).toBe(0);
  });

  it('maps a malformed 200 identity to [github_malformed_response]', async () => {
    const transport = new FakeGithubTransport({ userResponse: { status: 200, body: { not: 'an identity' } } });
    const v = await runGithubGetUserSmoke({ executor: realExecutor(transport), getMetadata: async () => githubMeta('active'), tenantId: TID, connectionId: CID, stdout: collect().stream });
    expect(v).toMatchObject({ outcome: 'fail', errorCode: 'github_malformed_response' });
  });
});

describe('runGithubGetUserSmoke — no sensitive data in logs', () => {
  it('never logs the access token on success or on a failure', async () => {
    const logged: unknown[] = [];
    const rec = (...args: unknown[]): void => { logged.push(...args); };
    const logger = { info: rec, warn: rec, error: rec, debug: rec, fatal: rec, trace: rec, child: () => logger } as unknown as Logger;
    for (const status of [200, 401]) {
      const transport = new FakeGithubTransport({ userResponse: status === 200 ? { ...okUser } : { status, body: {} } });
      const executor = new ToolExecutor(buildDiagnosticRegistry(transport, logger), fakeResolver());
      await runGithubGetUserSmoke({ executor, getMetadata: async () => githubMeta('active'), tenantId: TID, connectionId: CID, stdout: collect().stream });
    }
    expect(JSON.stringify(logged)).not.toContain(SENTINEL);
  });
});
describe('runGithubGetUserSmoke — decryption and unexpected failures are sanitized', () => {
  it('maps a classified decryption AppError to a sanitized FAIL', async () => {
    const store: RefreshableConnectionStore = {
      resolveWithEnvelope: vi.fn(async () => { throw new PermanentError('credential_decryption_failed', 'decrypt failed'); }),
      compareAndSwapCredential: vi.fn(),
    };
    const executor = realResolverExecutor(new FakeGithubTransport(), store, tokenSourceOf({ accessToken: 'x', tokenType: 'bearer' }));
    const v = await runGithubGetUserSmoke({ executor, getMetadata: async () => githubMeta('active'), tenantId: TID, connectionId: CID, stdout: collect().stream });
    expect(v).toMatchObject({ outcome: 'fail', errorCode: 'credential_decryption_failed' });
  });

  it('converts an UNEXPECTED non-AppError throw into [unexpected_error] without leaking it', async () => {
    const fake: ToolExecutorLike = { execute: async () => { throw new Error('raw-secret-ish-detail'); } };
    const out = collect();
    const v = await runGithubGetUserSmoke({ executor: fake, getMetadata: async () => githubMeta('active'), tenantId: TID, connectionId: CID, stdout: out.stream });
    expect(v).toMatchObject({ outcome: 'fail', errorCode: 'unexpected_error' });
    expect(out.text()).not.toContain('raw-secret-ish-detail');
  });
});

describe('runCli — a database connection failure is handled and the handle is closed', () => {
  it('FAILs sanitized and still closes the handle when verifyConnection rejects', async () => {
    const close = vi.fn(async () => undefined);
    const database = { db: {}, verifyConnection: vi.fn(async () => { throw new Error('db-unreachable-detail'); }), close } as never;
    const out = collect();
    const code = await runCli(
      { argv: [TID, CID], stdout: out.stream, stderr: collect().stream },
      { loadEnv: () => fakeEnv, createLogger: () => fakeLogger, createCipher: () => ({ hasKey: true } as never), createDatabase: () => database, runSmoke: vi.fn() },
    );
    expect(code).toBe(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(out.text()).toContain('FAIL');
    expect(out.text()).not.toContain('db-unreachable-detail');
  });
});

describe('isValidId — rejects non-UUID shapes', () => {
  it('accepts a UUID and rejects undefined/empty/short/long/non-hex', () => {
    expect(isValidId(TID)).toBe(true);
    for (const bad of [undefined, '', 'not-a-uuid', '123', TID.slice(0, -1), `${TID}x`, 'g'.repeat(36)]) {
      expect(isValidId(bad as string | undefined)).toBe(false);
    }
  });
});

describe('createQuietCliLogger — silent regardless of ambient LOG_LEVEL', () => {
  it('pins the level to silent and emits nothing even at LOG_LEVEL=info', () => {
    const lines: string[] = [];
    const env = parseEnv({ DATABASE_URL: 'postgresql://u:p@localhost:5432/ai_workforce_test', LOG_LEVEL: 'info' });
    const logger = createQuietCliLogger(env, { write: (chunk) => { lines.push(chunk); } });
    expect(logger.level).toBe('silent');
    logger.info({ database: { host: 'secret-db.internal', database: 'prod' } }, 'database connected');
    logger.error({ event: 'x', code: 'boom' }, 'error');
    logger.child({ tenant_id: TID }).info('child noise');
    expect(lines).toEqual([]);
  });
});

describe('runCli — stdout carries exactly one sanitized RESULT line (real quiet logger)', () => {
  it('emits exactly one PASS line and nothing else on success', async () => {
    const out = collect();
    const code = await runCli(
      { argv: [TID, CID], stdout: out.stream, stderr: collect().stream },
      {
        loadEnv: () => parseEnv({ DATABASE_URL: 'postgresql://u:p@localhost:5432/ai_workforce_test', LOG_LEVEL: 'info' }),
        createLogger: createQuietCliLogger,
        createCipher: () => ({ hasKey: true } as never),
        createDatabase: () => fakeDb(),
        runSmoke: async ({ stdout }) => { stdout.write('RESULT: PASS — login=Vansh-22f300\n'); return { outcome: 'pass', reason: 'ok', login: 'Vansh-22f300', exitCode: 0 }; },
      },
    );
    expect(code).toBe(0);
    expect(out.text()).toBe('RESULT: PASS — login=Vansh-22f300\n');
    expect(out.text().match(/\n/g)).toHaveLength(1);
  });

  it('emits exactly one sanitized FAIL line (code, no secrets) when init throws', async () => {
    const out = collect();
    const code = await runCli(
      { argv: [TID, CID], stdout: out.stream, stderr: collect().stream },
      {
        loadEnv: () => parseEnv({ DATABASE_URL: 'postgresql://u:p@localhost:5432/ai_workforce_test', LOG_LEVEL: 'info' }),
        createLogger: createQuietCliLogger,
        createCipher: () => ({ hasKey: true } as never),
        createDatabase: () => { throw new Error('fail postgres://user:S3CRET@db.internal:5432/prod token=ghp_LEAKLEAKLEAK'); },
      },
    );
    expect(code).toBe(1);
    const text = out.text();
    expect(text).toBe('RESULT: FAIL [unknown] — the smoke test could not run.\n');
    expect(text.match(/\n/g)).toHaveLength(1);
    for (const secret of ['S3CRET', 'ghp_LEAKLEAKLEAK', 'postgres://', 'db.internal']) {
      expect(text).not.toContain(secret);
    }
  });
});

describe('runGithubGetUserSmoke — a classified tool failure is one sanitized line', () => {
  it('prints exactly one FAIL line carrying the code and nothing else', async () => {
    const transport = new FakeGithubTransport({ userResponse: { status: 401, body: {} } });
    const out = collect();
    await runGithubGetUserSmoke({ executor: realExecutor(transport), getMetadata: async () => githubMeta('active'), tenantId: TID, connectionId: CID, stdout: out.stream });
    const text = out.text();
    expect(text).toMatch(/^RESULT: FAIL \[github_unauthorized\] — [^\n]+\n$/);
    expect(text.match(/\n/g)).toHaveLength(1);
  });
});
