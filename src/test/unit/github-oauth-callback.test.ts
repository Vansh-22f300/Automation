/**
 * GitHub OAuth callback flow — the finalizer wired into `OAuthService.completeCallback`.
 *
 * Uses the real {@link GithubConnectionFinalizer} over a fake transport, with the rest
 * of the OAuth collaborators faked. It proves the GitHub-specific half of the callback:
 * after the code exchange, the identity is validated and the connection is upserted
 * under the GitHub login with non-secret identity metadata; a failed exchange or a
 * failed identity lookup persists nothing.
 */

import { describe, expect, it, vi } from 'vitest';

import { GithubConnectionFinalizer } from '@/connectors/github/github-finalizer.js';
import { OAuthProviderError } from '@/oauth/errors.js';
import { OAuthService } from '@/oauth/oauth-service.js';
import { type OAuthProviderConfig, OAuthProviderRegistry } from '@/oauth/provider-config.js';
import type { OAuthTokenClient } from '@/oauth/token-client.js';
import type { TokenRevoker } from '@/oauth/token-source.js';
import type { ConnectionRepository } from '@/repositories/connection-repository.js';
import type { OAuthStateStore } from '@/repositories/oauth-state-repository.js';
import { FakeGithubTransport } from '@/test/support/fake-github-transport.js';

const config: OAuthProviderConfig = {
  provider: 'github',
  authorizationEndpoint: 'https://github.com/login/oauth/authorize',
  tokenEndpoint: 'https://github.com/login/oauth/access_token',
  clientId: 'client-id',
  clientSecret: 'client-secret',
  scopes: ['read:user', 'public_repo', 'offline_access'],
};
const consumedRow = { tenantId: 't9', userId: 'u9', provider: 'github', returnPath: '/connections', codeVerifier: 'verifier' };
const tokenSet = { accessToken: 'at', tokenType: 'bearer', refreshToken: 'rt', scope: 'read:user public_repo', expiresAt: new Date('2026-01-01T00:00:00.000Z') };

function makeService(options: { transport?: FakeGithubTransport; exchangeError?: Error } = {}) {
  const transport = options.transport ?? new FakeGithubTransport();
  const consume = vi.fn(async () => consumedRow);
  const exchangeCode = vi.fn(async () => {
    if (options.exchangeError !== undefined) throw options.exchangeError;
    return tokenSet;
  });
  const upsert = vi.fn(async () => ({ id: 'conn-gh-1' }));
  const repo = { upsertByProviderName: upsert } as unknown as ConnectionRepository;
  const service = new OAuthService({
    registry: new OAuthProviderRegistry([config]),
    stateStore: { create: vi.fn(), consume, deleteExpiredAndConsumed: vi.fn() } as unknown as OAuthStateStore,
    tokenClient: { exchangeCode } as unknown as OAuthTokenClient,
    revoker: { revoke: vi.fn() } as unknown as TokenRevoker,
    connectionRepositoryFor: () => repo,
    connectionFinalizers: new Map([['github', new GithubConnectionFinalizer({ transport })]]),
    appOrigin: 'https://app.example',
  });
  return { service, transport, exchangeCode, upsert };
}

const callback = () => ({ provider: 'github', state: 'opaque-state', code: 'the-code' });

describe('completeCallback with the GitHub finalizer', () => {
  it('upserts the connection under the GitHub login with non-secret identity metadata', async () => {
    const { service, transport, upsert } = makeService();
    const result = await service.completeCallback(callback());

    expect(transport.userCalls).toBe(1);
    // Credential carries the serialized token set; metadata carries only non-secret
    // identity descriptors; the connection name is the login (so re-auth heals a row).
    expect(upsert).toHaveBeenCalledWith({
      provider: 'github',
      name: 'octocat',
      credential: {
        accessToken: 'at',
        tokenType: 'bearer',
        refreshToken: 'rt',
        scope: 'read:user public_repo',
        expiresAt: '2026-01-01T00:00:00.000Z',
      },
      metadata: {
        provider: 'github',
        githubUserId: 42,
        login: 'octocat',
        displayName: 'The Octocat',
        scope: 'read:user public_repo',
      },
    });
    expect(result).toEqual({ returnPath: '/connections', connectionId: 'conn-gh-1' });
  });

  it('persists nothing when the identity lookup fails (token obtained but identity rejected)', async () => {
    const { service, upsert } = makeService({ transport: new FakeGithubTransport({ userResponse: { status: 401, body: {} } }) });
    await expect(service.completeCallback(callback())).rejects.toBeInstanceOf(OAuthProviderError);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('persists nothing and never calls the identity endpoint when the code exchange fails', async () => {
    const { service, transport, upsert } = makeService({ exchangeError: new OAuthProviderError('rejected', 'invalid_grant') });
    await expect(service.completeCallback(callback())).rejects.toBeInstanceOf(OAuthProviderError);
    expect(transport.userCalls).toBe(0);
    expect(upsert).not.toHaveBeenCalled();
  });
});
