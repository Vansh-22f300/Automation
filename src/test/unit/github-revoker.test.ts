/**
 * GitHub token revoker unit tests — with a fake fetch and a fake repository.
 *
 * These pin the disconnect contract: a real DELETE to the app's token-revocation
 * endpoint with HTTP Basic `client_id:client_secret` and the access token in the body;
 * best-effort (never throws, so the local disconnect proceeds); a no-op for a non-
 * GitHub provider or a credential with no token; and no token material in logs.
 */

import { describe, expect, it, vi } from 'vitest';

import { GithubTokenRevoker } from '@/connectors/github/github-revoker.js';
import { createGithubProviderConfig } from '@/oauth/providers/github.js';
import { OAuthProviderRegistry } from '@/oauth/provider-config.js';
import type { ConnectionRepository } from '@/repositories/connection-repository.js';

const ACCESS_TOKEN = 'gho_REVOKE_SECRET';
const registry = new OAuthProviderRegistry([
  createGithubProviderConfig({ GITHUB_CLIENT_ID: 'client-id', GITHUB_CLIENT_SECRET: 'client-secret' })!,
]);
const REVOCATION_URL = 'https://api.github.com/applications/client-id/token';
const EXPECTED_BASIC = `Basic ${Buffer.from('client-id:client-secret', 'utf8').toString('base64')}`;

/** A fake repo whose resolveForTool yields a credential with (or without) a token. */
function repoFactory(credential: Record<string, unknown>) {
  return (_tenantId: string): ConnectionRepository =>
    ({
      resolveForTool: async () => ({
        metadata: {
          id: 'conn-gh-1',
          provider: 'github',
          name: 'octocat',
          status: 'active' as const,
          metadata: {},
          createdAt: new Date(0),
          updatedAt: new Date(0),
          lastUsedAt: null,
        },
        credential,
      }),
    }) as unknown as ConnectionRepository;
}

const request = { provider: 'github', tenantId: 't1', connectionId: 'conn-gh-1' };

describe('GithubTokenRevoker', () => {
  it('DELETEs the token with Basic auth and the access token in the body', async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
      seen = { url, init };
      return { status: 204 } as Response;
    });
    await new GithubTokenRevoker({
      registry,
      connectionRepositoryFor: repoFactory({ accessToken: ACCESS_TOKEN, tokenType: 'bearer' }),
      fetch: fetchFn,
    }).revoke(request);

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(seen!.url).toBe(REVOCATION_URL);
    expect(seen!.init.method).toBe('DELETE');
    expect((seen!.init.headers as Record<string, string>)['authorization']).toBe(EXPECTED_BASIC);
    expect(JSON.parse(seen!.init.body as string)).toEqual({ access_token: ACCESS_TOKEN });
  });

  it('is best-effort: a fetch failure is swallowed (disconnect still proceeds) and logs no token', async () => {
    const info = vi.fn();
    const warn = vi.fn();
    const logger = { info, warn, error: vi.fn(), debug: vi.fn(), child: vi.fn() } as never;
    const fetchFn = vi.fn(async () => {
      throw new Error('network down');
    });
    await expect(
      new GithubTokenRevoker({
        registry,
        connectionRepositoryFor: repoFactory({ accessToken: ACCESS_TOKEN, tokenType: 'bearer' }),
        fetch: fetchFn,
        logger,
      }).revoke(request),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(info.mock.calls.concat(warn.mock.calls))).not.toContain(ACCESS_TOKEN);
  });

  it('no-ops for a non-GitHub provider (never resolves a credential or calls fetch)', async () => {
    const fetchFn = vi.fn();
    const connectionRepositoryFor = vi.fn(repoFactory({ accessToken: ACCESS_TOKEN, tokenType: 'bearer' }));
    await new GithubTokenRevoker({ registry, connectionRepositoryFor, fetch: fetchFn }).revoke({
      ...request,
      provider: 'slack',
    });
    expect(connectionRepositoryFor).not.toHaveBeenCalled();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('no-ops when the credential carries no access token', async () => {
    const fetchFn = vi.fn();
    await new GithubTokenRevoker({
      registry,
      connectionRepositoryFor: repoFactory({ tokenType: 'bearer' }),
      fetch: fetchFn,
    }).revoke(request);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
