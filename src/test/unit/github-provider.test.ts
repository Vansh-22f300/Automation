/**
 * GitHub provider-config unit tests.
 *
 * These pin the Phase-1 contract: GitHub is a provider-neutral config built only from
 * validated env, it is registered only when fully configured (both id and secret),
 * its scopes are the fixed minimal set (never `repo`), and the authorization URL the
 * foundation builds from it carries exactly the PKCE + scope parameters GitHub expects.
 */

import { describe, expect, it } from 'vitest';

import type { Env } from '@/config/env.js';
import {
  createGithubProviderConfig,
  GITHUB_AUTHORIZATION_ENDPOINT,
  GITHUB_DEFAULT_SCOPES,
  GITHUB_PROVIDER,
  GITHUB_TOKEN_ENDPOINT,
  githubRevocationEndpoint,
} from '@/oauth/providers/github.js';
import { loadOAuthProviders } from '@/oauth/providers/index.js';
import { buildAuthorizationUrl } from '@/oauth/provider-config.js';

const configured = { GITHUB_CLIENT_ID: 'Iv1.abc123', GITHUB_CLIENT_SECRET: 'secret-value' };

describe('createGithubProviderConfig', () => {
  it('returns a complete config when both id and secret are set', () => {
    const config = createGithubProviderConfig(configured);
    expect(config).toEqual({
      provider: GITHUB_PROVIDER,
      authorizationEndpoint: GITHUB_AUTHORIZATION_ENDPOINT,
      tokenEndpoint: GITHUB_TOKEN_ENDPOINT,
      revocationEndpoint: githubRevocationEndpoint('Iv1.abc123'),
      clientId: 'Iv1.abc123',
      clientSecret: 'secret-value',
      scopes: GITHUB_DEFAULT_SCOPES,
    });
  });

  it('requests the fixed minimal scopes and never the broad `repo` scope', () => {
    expect(GITHUB_DEFAULT_SCOPES).toEqual(['read:user', 'public_repo', 'offline_access']);
    expect(GITHUB_DEFAULT_SCOPES).not.toContain('repo');
  });

  it('is undefined when the id or the secret is missing (no half-configured provider)', () => {
    expect(createGithubProviderConfig({ GITHUB_CLIENT_ID: 'only-id' })).toBeUndefined();
    expect(createGithubProviderConfig({ GITHUB_CLIENT_SECRET: 'only-secret' })).toBeUndefined();
    expect(createGithubProviderConfig({})).toBeUndefined();
  });
});

describe('loadOAuthProviders', () => {
  it('registers GitHub only when configured', () => {
    expect(loadOAuthProviders(configured as unknown as Env).map((c) => c.provider)).toEqual([GITHUB_PROVIDER]);
    expect(loadOAuthProviders({} as unknown as Env)).toEqual([]);
  });
});

describe('authorization URL built from the GitHub config', () => {
  it('carries client_id, redirect_uri, state, S256 challenge and the GitHub scopes', () => {
    const config = createGithubProviderConfig(configured)!;
    const url = buildAuthorizationUrl({
      config,
      redirectUri: 'https://app.example/oauth/github/callback',
      state: 'opaque-state',
      codeChallenge: 'challenge-value',
    });
    const params = new URL(url).searchParams;
    expect(url.startsWith(GITHUB_AUTHORIZATION_ENDPOINT)).toBe(true);
    expect(params.get('client_id')).toBe('Iv1.abc123');
    expect(params.get('redirect_uri')).toBe('https://app.example/oauth/github/callback');
    expect(params.get('state')).toBe('opaque-state');
    expect(params.get('code_challenge')).toBe('challenge-value');
    expect(params.get('code_challenge_method')).toBe('S256');
    expect(params.get('scope')).toBe('read:user public_repo offline_access');
    // The client secret is never placed in the browser-facing authorize URL.
    expect(url).not.toContain('secret-value');
  });
});
