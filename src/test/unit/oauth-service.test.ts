/**
 * Unit tests for the OAuth orchestrator (`@/oauth/oauth-service`) — state design
 * §5/§6/§8/§12/§14. These pin the trust boundary that defeats the confused deputy:
 * `beginAuthorization` seals the AUTHENTICATED tenant/user into the state row and
 * lets only the state's HASH (never the raw state) and a challenge derived from the
 * stored verifier reach the URL; `completeCallback` RECOVERS tenant/user/return
 * path/verifier from the consumed row and trusts the query for nothing else. All
 * collaborators are fakes — no registry lookup escapes the allowlist, no I/O runs.
 */

import { describe, expect, it, vi } from 'vitest';

import { BadRequestError } from '@/api/errors.js';
import type { AppError } from '@/domain/errors.js';
import { OAuthProviderError, OAuthStateInvalidError } from '@/oauth/errors.js';
import { DEFAULT_STATE_TTL_MS, OAuthService } from '@/oauth/oauth-service.js';
import { deriveCodeChallenge } from '@/oauth/pkce.js';
import { type OAuthProviderConfig, OAuthProviderRegistry } from '@/oauth/provider-config.js';
import { hashOAuthState } from '@/oauth/state-token.js';
import type { OAuthTokenClient } from '@/oauth/token-client.js';
import type { TokenRevoker } from '@/oauth/token-source.js';
import type { ConnectionRepository } from '@/repositories/connection-repository.js';
import type { CreateOAuthStateInput, OAuthStateStore } from '@/repositories/oauth-state-repository.js';

const config: OAuthProviderConfig = {
  provider: 'demo',
  authorizationEndpoint: 'https://provider.example/authorize',
  tokenEndpoint: 'https://provider.example/token',
  clientId: 'client-id-123',
  clientSecret: 'super-secret-value',
  scopes: ['read', 'write'],
};

const NOW = 1_000_000;
const REDIRECT_URI = 'https://app.example/oauth/demo/callback';

const rejected = async (p: Promise<unknown>): Promise<AppError> => {
  try {
    await p;
  } catch (error) {
    return error as AppError;
  }
  throw new Error('expected the promise to reject, but it resolved');
};

const makeService = (registry = new OAuthProviderRegistry([config])) => {
  const create = vi.fn(async (_input: CreateOAuthStateInput): Promise<void> => {});
  const consume = vi.fn();
  const exchangeCode = vi.fn();
  const revoke = vi.fn(async (): Promise<void> => {});
  const repoCreate = vi.fn();
  const getMetadata = vi.fn();
  const disable = vi.fn();
  const repo = { create: repoCreate, getMetadata, disable } as unknown as ConnectionRepository;
  const connectionRepositoryFor = vi.fn((_tenantId: string) => repo);
  const service = new OAuthService({
    registry,
    stateStore: { create, consume, deleteExpiredAndConsumed: vi.fn() } as unknown as OAuthStateStore,
    tokenClient: { exchangeCode } as unknown as OAuthTokenClient,
    revoker: { revoke } as unknown as TokenRevoker,
    connectionRepositoryFor,
    appOrigin: 'https://app.example',
    now: () => NOW,
  });
  return { service, create, consume, exchangeCode, revoke, repoCreate, getMetadata, disable, connectionRepositoryFor };
};

describe('beginAuthorization', () => {
  it('seals the caller into the row, exposing only the state hash + a challenge bound to the stored verifier', async () => {
    const { service, create } = makeService();
    const { authorizationUrl } = await service.beginAuthorization({ tenantId: 't1', userId: 'u1', provider: 'demo' });

    expect(create).toHaveBeenCalledTimes(1);
    const row = create.mock.calls[0]![0];
    expect(row).toMatchObject({ tenantId: 't1', userId: 'u1', provider: 'demo', returnPath: '/connections' });
    expect(row.expiresAt).toEqual(new Date(NOW + DEFAULT_STATE_TTL_MS));
    expect(row.stateHash).toMatch(/^[0-9a-f]{64}$/);

    const params = new URL(authorizationUrl).searchParams;
    expect(hashOAuthState(params.get('state')!)).toBe(row.stateHash); // raw state only in the URL; hash at rest
    expect(params.get('code_challenge')).toBe(deriveCodeChallenge(row.codeVerifier)); // challenge binds the stored verifier
    expect(params.get('redirect_uri')).toBe(REDIRECT_URI); // fixed origin, never a Host header
    expect(params.get('scope')).toBe('read write');
  });

  it('passes a scope override through to the URL', async () => {
    const { service } = makeService();
    const { authorizationUrl } = await service.beginAuthorization({
      tenantId: 't1',
      userId: 'u1',
      provider: 'demo',
      scopes: ['repo'],
    });
    expect(new URL(authorizationUrl).searchParams.get('scope')).toBe('repo');
  });

  it('rejects an unsafe return path loudly and persists nothing', async () => {
    const { service, create } = makeService();
    const error = await rejected(
      service.beginAuthorization({ tenantId: 't1', userId: 'u1', provider: 'demo', returnPath: '//evil.example' }),
    );
    expect(error).toBeInstanceOf(BadRequestError);
    expect(create).not.toHaveBeenCalled();
  });

  it('fails closed for an unregistered provider and persists nothing', async () => {
    const { service, create } = makeService();
    const error = await rejected(service.beginAuthorization({ tenantId: 't1', userId: 'u1', provider: 'github' }));
    expect(error).toBeInstanceOf(OAuthProviderError);
    expect(error.details).toEqual({ reason: 'unknown_provider' });
    expect(create).not.toHaveBeenCalled();
  });
});

describe('completeCallback', () => {
  const consumedRow = { tenantId: 't9', userId: 'u9', provider: 'demo', returnPath: '/connections?tab=demo', codeVerifier: 'the-verifier' };
  const tokenSet = { accessToken: 'at', tokenType: 'bearer', refreshToken: 'rt', scope: 'read', expiresAt: new Date('2026-01-01T00:00:00.000Z') };

  it('recovers the trusted context from the row and persists the exchanged token', async () => {
    const { service, consume, exchangeCode, repoCreate, connectionRepositoryFor } = makeService();
    consume.mockResolvedValue(consumedRow);
    exchangeCode.mockResolvedValue(tokenSet);
    repoCreate.mockResolvedValue({ id: 'conn-1' });

    const result = await service.completeCallback({ provider: 'demo', state: 'opaque-state', code: 'the-code' });

    expect(consume).toHaveBeenCalledWith({ stateHash: hashOAuthState('opaque-state'), provider: 'demo' });
    // Verifier + redirect URI come from the row / server config, never the callback query.
    expect(exchangeCode).toHaveBeenCalledWith({ config, code: 'the-code', redirectUri: REDIRECT_URI, codeVerifier: 'the-verifier' });
    expect(connectionRepositoryFor).toHaveBeenCalledWith('t9'); // tenant recovered from the row
    expect(repoCreate).toHaveBeenCalledWith({
      provider: 'demo',
      name: 'demo',
      credential: { accessToken: 'at', tokenType: 'bearer', refreshToken: 'rt', scope: 'read', expiresAt: '2026-01-01T00:00:00.000Z' },
    });
    expect(result).toEqual({ returnPath: '/connections?tab=demo', connectionId: 'conn-1' });
  });

  it('throws an undifferentiated invalid-state error when consume finds no row, touching no provider', async () => {
    const { service, consume, exchangeCode, connectionRepositoryFor } = makeService();
    consume.mockResolvedValue(null);
    const error = await rejected(service.completeCallback({ provider: 'demo', state: 'x', code: 'y' }));
    expect(error).toBeInstanceOf(OAuthStateInvalidError);
    expect(exchangeCode).not.toHaveBeenCalled();
    expect(connectionRepositoryFor).not.toHaveBeenCalled();
  });
});

describe('disconnect', () => {
  it('revokes then disables when the connection exists in the tenant', async () => {
    const { service, getMetadata, revoke, disable, connectionRepositoryFor } = makeService();
    getMetadata.mockResolvedValue({ provider: 'demo' });
    disable.mockResolvedValue({});
    expect(await service.disconnect({ tenantId: 't1', connectionId: 'c1' })).toBe(true);
    expect(connectionRepositoryFor).toHaveBeenCalledWith('t1');
    expect(revoke).toHaveBeenCalledWith({ provider: 'demo', tenantId: 't1', connectionId: 'c1' });
    expect(disable).toHaveBeenCalledWith('c1');
  });

  it('returns false and touches neither revoke nor disable when the connection is absent', async () => {
    const { service, getMetadata, revoke, disable } = makeService();
    getMetadata.mockResolvedValue(null);
    expect(await service.disconnect({ tenantId: 't1', connectionId: 'missing' })).toBe(false);
    expect(revoke).not.toHaveBeenCalled();
    expect(disable).not.toHaveBeenCalled();
  });
});
