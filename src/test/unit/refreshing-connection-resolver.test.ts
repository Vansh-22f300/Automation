/**
 * RefreshingConnectionResolver unit tests — the concurrency-safe refresh write-back.
 *
 * This resolver is the seam that keeps OAuth access tokens fresh for tool execution.
 * These tests use a fake store + fake token source (no DB, no network) to pin the
 * behaviours the task's refresh contract requires:
 *   - a non-OAuth credential passes straight through (provider-neutral);
 *   - a still-valid token is returned without a write;
 *   - a refresh is persisted under compare-and-swap keyed on the ciphertext read;
 *   - when a concurrent writer won (CAS `superseded`), this worker ADOPTS the winner's
 *     freshly-persisted credential instead of reusing a rotated-away refresh token;
 *   - an unrefreshable credential surfaces the token source's permanent error.
 */

import { describe, expect, it, vi } from 'vitest';

import { OAuthProviderError } from '@/oauth/errors.js';
import { RefreshingConnectionResolver } from '@/oauth/refreshing-connection-resolver.js';
import type { RefreshableConnectionStore } from '@/oauth/refreshing-connection-resolver.js';
import type { AccessTokenResult, TokenSource } from '@/oauth/token-source.js';
import type {
  AuthorizedConnectionWithEnvelope,
  CredentialSwapOutcome,
} from '@/repositories/connection-repository.js';

const CT_OLD = 'CT-OLD-ciphertext';
const REF: { provider: string; connectionId: string } = { provider: 'github', connectionId: 'conn-gh-1' };

function resolution(credential: Record<string, unknown>): AuthorizedConnectionWithEnvelope {
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
    encryptedCredentials: { v: 1, alg: 'aes-256-gcm', iv: 'IV', ct: CT_OLD, tag: 'TAG' },
  };
}

function makeStore(resolved: AuthorizedConnectionWithEnvelope, swap: CredentialSwapOutcome) {
  const resolveWithEnvelope = vi.fn(async () => resolved);
  const compareAndSwapCredential = vi.fn(async () => swap);
  const store: RefreshableConnectionStore = { resolveWithEnvelope, compareAndSwapCredential };
  return { store, resolveWithEnvelope, compareAndSwapCredential };
}

function makeTokenSource(result: AccessTokenResult | Error) {
  const getAccessToken = vi.fn(async () => {
    if (result instanceof Error) throw result;
    return result;
  });
  return { tokenSource: { getAccessToken } as TokenSource, getAccessToken };
}

const APPLIED: CredentialSwapOutcome = { status: 'applied', credential: {}, encryptedCredentials: { v: 1, alg: 'aes-256-gcm', iv: 'IV', ct: 'CT-NEW', tag: 'TAG' } };

describe('RefreshingConnectionResolver passthrough', () => {
  it('returns a non-OAuth credential untouched and never calls the token source', async () => {
    const { store, compareAndSwapCredential } = makeStore(resolution({ botToken: 'xoxb-slackish' }), APPLIED);
    const { tokenSource, getAccessToken } = makeTokenSource({ accessToken: 'x', tokenType: 'bearer' });
    const result = await new RefreshingConnectionResolver(store, tokenSource).resolveForTool(REF);
    expect(result.credential).toEqual({ botToken: 'xoxb-slackish' });
    expect(getAccessToken).not.toHaveBeenCalled();
    expect(compareAndSwapCredential).not.toHaveBeenCalled();
  });

  it('returns a still-valid OAuth token without a write-back', async () => {
    const credential = { accessToken: 'at', tokenType: 'bearer', expiresAt: '2999-01-01T00:00:00.000Z' };
    const { store, compareAndSwapCredential } = makeStore(resolution(credential), APPLIED);
    // The token source reports no refresh happened (`refreshed` absent).
    const { tokenSource, getAccessToken } = makeTokenSource({ accessToken: 'at', tokenType: 'bearer' });
    const result = await new RefreshingConnectionResolver(store, tokenSource).resolveForTool(REF);
    expect(getAccessToken).toHaveBeenCalledWith({ provider: 'github', credential });
    expect(result.credential).toEqual(credential);
    expect(compareAndSwapCredential).not.toHaveBeenCalled();
  });

  it('surfaces an unrefreshable credential as the token source’s permanent error, no write', async () => {
    const { store, compareAndSwapCredential } = makeStore(
      resolution({ accessToken: 'at', tokenType: 'bearer', refreshToken: 'dead', expiresAt: '2000-01-01T00:00:00.000Z' }),
      APPLIED,
    );
    const { tokenSource } = makeTokenSource(new OAuthProviderError('refresh token expired', 'not_refreshable'));
    const resolver = new RefreshingConnectionResolver(store, tokenSource);
    await expect(resolver.resolveForTool(REF)).rejects.toBeInstanceOf(OAuthProviderError);
    expect(compareAndSwapCredential).not.toHaveBeenCalled();
  });
});

describe('RefreshingConnectionResolver write-back under concurrency', () => {
  const refreshed = {
    accessToken: 'new-at',
    tokenType: 'bearer',
    refreshToken: 'new-rt',
    scope: 'read:user',
    expiresAt: new Date('2026-02-01T00:00:00.000Z'),
    refreshTokenExpiresAt: new Date('2026-08-01T00:00:00.000Z'),
  };
  // What serializeTokenSet(refreshed) must produce — the rotated set, incl. the new
  // refresh token and both expiries, ISO-encoded, persisted via compare-and-swap.
  const persisted = {
    accessToken: 'new-at',
    tokenType: 'bearer',
    refreshToken: 'new-rt',
    scope: 'read:user',
    expiresAt: '2026-02-01T00:00:00.000Z',
    refreshTokenExpiresAt: '2026-08-01T00:00:00.000Z',
  };
  const expiredOauth = { accessToken: 'old-at', tokenType: 'bearer', refreshToken: 'old-rt', expiresAt: '2000-01-01T00:00:00.000Z' };
  const result: AccessTokenResult = { accessToken: 'new-at', tokenType: 'bearer', refreshed };

  it('persists the rotated set via compare-and-swap keyed on the ciphertext it read (applied)', async () => {
    const { store, compareAndSwapCredential } = makeStore(resolution(expiredOauth), APPLIED);
    const { tokenSource } = makeTokenSource(result);
    const out = await new RefreshingConnectionResolver(store, tokenSource).resolveForTool(REF);
    expect(compareAndSwapCredential).toHaveBeenCalledWith('conn-gh-1', CT_OLD, persisted);
    expect(out.credential).toEqual(persisted);
  });

  it('ADOPTS the winner’s credential when a concurrent writer rotated first (superseded)', async () => {
    const winner = { accessToken: 'winner-at', tokenType: 'bearer', refreshToken: 'winner-rt' };
    const superseded: CredentialSwapOutcome = {
      status: 'superseded',
      credential: winner,
      encryptedCredentials: { v: 1, alg: 'aes-256-gcm', iv: 'IV', ct: 'CT-WINNER', tag: 'TAG' },
    };
    const { store, compareAndSwapCredential } = makeStore(resolution(expiredOauth), superseded);
    const { tokenSource } = makeTokenSource(result);
    const out = await new RefreshingConnectionResolver(store, tokenSource).resolveForTool(REF);
    // The stale refresh token is NOT reused: the already-persisted winner is adopted.
    expect(out.credential).toEqual(winner);
    expect(compareAndSwapCredential).toHaveBeenCalledWith('conn-gh-1', CT_OLD, persisted);
  });

  it('uses the freshly-refreshed token for this call when the row vanished (missing)', async () => {
    const { store } = makeStore(resolution(expiredOauth), { status: 'missing' });
    const { tokenSource } = makeTokenSource(result);
    const out = await new RefreshingConnectionResolver(store, tokenSource).resolveForTool(REF);
    expect(out.credential).toEqual(persisted);
  });
});

describe('RefreshingConnectionResolver losing a refresh race', () => {
  const expired = { accessToken: 'old-at', tokenType: 'bearer', refreshToken: 'old-rt', expiresAt: '2000-01-01T00:00:00.000Z' };

  it('re-reads and adopts a concurrently-refreshed credential when our refresh is rejected', async () => {
    const winner = { accessToken: 'winner-at', tokenType: 'bearer', refreshToken: 'winner-rt', expiresAt: '2999-01-01T00:00:00.000Z' };
    const second: AuthorizedConnectionWithEnvelope = {
      ...resolution(winner),
      encryptedCredentials: { v: 1, alg: 'aes-256-gcm', iv: 'IV', ct: 'CT-WINNER', tag: 'TAG' },
    };
    const resolveWithEnvelope = vi.fn().mockResolvedValueOnce(resolution(expired)).mockResolvedValueOnce(second);
    const compareAndSwapCredential = vi.fn();
    const store: RefreshableConnectionStore = { resolveWithEnvelope, compareAndSwapCredential };
    // Our refresh is rejected (the winner already rotated the token); the re-read's
    // token is valid, so the second getAccessToken is a passthrough (no `refreshed`).
    const getAccessToken = vi
      .fn()
      .mockRejectedValueOnce(new OAuthProviderError('invalid_grant', 'invalid_grant'))
      .mockResolvedValueOnce({ accessToken: 'winner-at', tokenType: 'bearer' });
    const out = await new RefreshingConnectionResolver(store, { getAccessToken } as TokenSource).resolveForTool(REF);
    expect(resolveWithEnvelope).toHaveBeenCalledTimes(2);
    expect(out.credential).toEqual(winner); // adopted the winner; never reused the stale refresh token
    expect(compareAndSwapCredential).not.toHaveBeenCalled();
  });

  it('surfaces the refresh failure when a re-read shows the credential did not change', async () => {
    const resolveWithEnvelope = vi.fn().mockResolvedValue(resolution(expired)); // same ct both reads
    const compareAndSwapCredential = vi.fn();
    const store: RefreshableConnectionStore = { resolveWithEnvelope, compareAndSwapCredential };
    const getAccessToken = vi.fn().mockRejectedValue(new OAuthProviderError('refresh token expired', 'not_refreshable'));
    const resolver = new RefreshingConnectionResolver(store, { getAccessToken } as TokenSource);
    await expect(resolver.resolveForTool(REF)).rejects.toBeInstanceOf(OAuthProviderError);
    expect(resolveWithEnvelope).toHaveBeenCalledTimes(2); // tried a re-read before giving up
    expect(compareAndSwapCredential).not.toHaveBeenCalled();
  });
});
