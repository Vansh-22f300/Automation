/**
 * Unit tests for the provider-neutral token seam (`@/oauth/token-source`) — state
 * design §12/§13. `serializeTokenSet` flattens a token set into the persisted
 * credential; `RefreshingTokenSource` passes a valid token through and refreshes an
 * expired one via an injected client, resolving the provider ONLY through the
 * fail-closed registry. These pin the passthrough/refresh policy, the skew
 * boundary, refresh-token merge semantics, and the no-op revoker. No real I/O.
 */

import { describe, expect, it, vi } from 'vitest';

import type { AppError } from '@/domain/errors.js';
import { OAuthProviderError } from '@/oauth/errors.js';
import { type OAuthProviderConfig, OAuthProviderRegistry } from '@/oauth/provider-config.js';
import type { OAuthTokenClient } from '@/oauth/token-client.js';
import {
  DEFAULT_REFRESH_SKEW_MS,
  NoopTokenRevoker,
  RefreshingTokenSource,
  serializeTokenSet,
} from '@/oauth/token-source.js';

const config: OAuthProviderConfig = {
  provider: 'demo',
  authorizationEndpoint: 'https://provider.example/authorize',
  tokenEndpoint: 'https://provider.example/token',
  clientId: 'client-id-123',
  clientSecret: 'super-secret-value',
  scopes: ['read'],
};

const NOW = 1_700_000_000_000;
const iso = (ms: number): string => new Date(ms).toISOString();

const rejected = async (p: Promise<unknown>): Promise<AppError> => {
  try {
    await p;
  } catch (error) {
    return error as AppError;
  }
  throw new Error('expected the promise to reject, but it resolved');
};

const makeSource = (registry = new OAuthProviderRegistry([config])) => {
  const refresh = vi.fn();
  const source = new RefreshingTokenSource({ refresh } as unknown as OAuthTokenClient, registry, { now: () => NOW });
  return { source, refresh };
};

describe('serializeTokenSet', () => {
  it('flattens a full set, ISO-encoding the expiry', () => {
    expect(
      serializeTokenSet({
        accessToken: 'at',
        tokenType: 'Bearer',
        refreshToken: 'rt',
        scope: 'read',
        expiresAt: new Date('2026-01-01T00:00:00.000Z'),
      }),
    ).toEqual({ accessToken: 'at', tokenType: 'Bearer', refreshToken: 'rt', scope: 'read', expiresAt: '2026-01-01T00:00:00.000Z' });
  });

  it('omits absent optionals', () => {
    expect(serializeTokenSet({ accessToken: 'at', tokenType: 'bearer' })).toEqual({
      accessToken: 'at',
      tokenType: 'bearer',
    });
  });
});

describe('RefreshingTokenSource', () => {
  it('passes a still-valid token through without refreshing', async () => {
    const { source, refresh } = makeSource();
    const credential = { accessToken: 'at', tokenType: 'bearer', expiresAt: iso(NOW + 3_600_000) };
    expect(await source.getAccessToken({ provider: 'demo', credential })).toEqual({ accessToken: 'at', tokenType: 'bearer' });
    expect(refresh).not.toHaveBeenCalled();
  });

  it('treats a credential with no stated expiry as valid', async () => {
    const { source, refresh } = makeSource();
    expect(await source.getAccessToken({ provider: 'demo', credential: { accessToken: 'at', tokenType: 'bearer' } })).toEqual({
      accessToken: 'at',
      tokenType: 'bearer',
    });
    expect(refresh).not.toHaveBeenCalled();
  });

  it('fails permanently when an expired token has no refresh token', async () => {
    const { source } = makeSource();
    const credential = { accessToken: 'at', tokenType: 'bearer', expiresAt: iso(NOW - 1000) };
    const error = await rejected(source.getAccessToken({ provider: 'demo', credential }));
    expect(error).toBeInstanceOf(OAuthProviderError);
    expect(error.details).toEqual({ reason: 'not_refreshable' });
  });

  it('refreshes an expired token, keeping the old refresh token when the provider omits one', async () => {
    const { source, refresh } = makeSource();
    refresh.mockResolvedValue({ accessToken: 'new-at', tokenType: 'bearer' });
    const credential = { accessToken: 'old-at', tokenType: 'bearer', refreshToken: 'old-rt', expiresAt: iso(NOW - 1000) };
    const result = await source.getAccessToken({ provider: 'demo', credential });
    expect(refresh).toHaveBeenCalledWith({ config, refreshToken: 'old-rt' });
    expect(result.accessToken).toBe('new-at');
    expect(result.refreshed).toEqual({ accessToken: 'new-at', tokenType: 'bearer', refreshToken: 'old-rt' });
  });

  it('takes the provider’s new refresh token when one is returned', async () => {
    const { source, refresh } = makeSource();
    refresh.mockResolvedValue({ accessToken: 'new-at', tokenType: 'bearer', refreshToken: 'new-rt' });
    const credential = { accessToken: 'old-at', tokenType: 'bearer', refreshToken: 'old-rt', expiresAt: iso(NOW - 1000) };
    const result = await source.getAccessToken({ provider: 'demo', credential });
    expect(result.refreshed?.refreshToken).toBe('new-rt');
  });

  it('applies the refresh skew at the boundary (at skew → refresh, one ms past → valid)', async () => {
    const atBoundary = makeSource();
    atBoundary.refresh.mockResolvedValue({ accessToken: 'refreshed', tokenType: 'bearer' });
    await atBoundary.source.getAccessToken({
      provider: 'demo',
      credential: { accessToken: 'at', tokenType: 'bearer', refreshToken: 'rt', expiresAt: iso(NOW + DEFAULT_REFRESH_SKEW_MS) },
    });
    expect(atBoundary.refresh).toHaveBeenCalled();

    const past = makeSource();
    const result = await past.source.getAccessToken({
      provider: 'demo',
      credential: { accessToken: 'at', tokenType: 'bearer', refreshToken: 'rt', expiresAt: iso(NOW + DEFAULT_REFRESH_SKEW_MS + 1) },
    });
    expect(past.refresh).not.toHaveBeenCalled();
    expect(result).toEqual({ accessToken: 'at', tokenType: 'bearer' });
  });

  it('treats an unparseable expiry as expired', async () => {
    const { source, refresh } = makeSource();
    refresh.mockResolvedValue({ accessToken: 'refreshed', tokenType: 'bearer' });
    await source.getAccessToken({
      provider: 'demo',
      credential: { accessToken: 'at', tokenType: 'bearer', refreshToken: 'rt', expiresAt: 'not-a-date' },
    });
    expect(refresh).toHaveBeenCalled();
  });

  it('fails closed for an unregistered provider before any refresh', async () => {
    const { source, refresh } = makeSource(new OAuthProviderRegistry());
    const credential = { accessToken: 'at', tokenType: 'bearer', refreshToken: 'rt', expiresAt: iso(NOW - 1000) };
    const error = await rejected(source.getAccessToken({ provider: 'demo', credential }));
    expect(error).toBeInstanceOf(OAuthProviderError);
    expect(error.details).toEqual({ reason: 'unknown_provider' });
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe('NoopTokenRevoker', () => {
  it('resolves to undefined (disconnect still removes the local connection)', async () => {
    await expect(
      new NoopTokenRevoker().revoke({ provider: 'demo', tenantId: 't1', connectionId: 'c1' }),
    ).resolves.toBeUndefined();
  });
});

it('DEFAULT_REFRESH_SKEW_MS is one minute', () => {
  expect(DEFAULT_REFRESH_SKEW_MS).toBe(60_000);
});
