/**
 * Unit tests for the allowlisted provider registry and the authorization-URL
 * builder (`@/oauth/provider-config`) — state design §8/§13. These pin the
 * fail-closed contract that makes the attacker-controlled `:provider` segment
 * safe: an unregistered or malformed slug resolves to nothing (never an
 * injected endpoint), the registry is EMPTY in this foundation phase, and the
 * built URL always carries `response_type=code` + `S256` and never the client
 * secret.
 */

import { describe, expect, it } from 'vitest';

import { OAuthProviderError } from '@/oauth/errors.js';
import {
  type OAuthProviderConfig,
  OAuthProviderRegistry,
  buildAuthorizationUrl,
  isValidProviderSlug,
} from '@/oauth/provider-config.js';

/** Capture a thrown error so its class and `details` can be asserted. */
const caught = <T>(fn: () => unknown): T => {
  try {
    fn();
  } catch (error) {
    return error as T;
  }
  throw new Error('expected the function to throw, but it did not');
};

const demoConfig: OAuthProviderConfig = {
  provider: 'demo',
  authorizationEndpoint: 'https://provider.example/authorize',
  tokenEndpoint: 'https://provider.example/token',
  clientId: 'client-id-123',
  clientSecret: 'super-secret-value',
  scopes: ['read', 'write'],
};

describe('isValidProviderSlug', () => {
  it('accepts lowercase slugs that start with a letter and are ≤32 chars', () => {
    for (const value of ['github', 'g', `g${'a'.repeat(31)}`, 'git-hub']) {
      expect(isValidProviderSlug(value)).toBe(true);
    }
  });

  it('rejects empty, uppercase, digit/hyphen-led, underscored, over-long, or dotted slugs', () => {
    for (const value of ['', 'Github', '1github', '-github', 'github_x', `g${'a'.repeat(32)}`, 'git.hub']) {
      expect(isValidProviderSlug(value)).toBe(false);
    }
  });
});

describe('OAuthProviderRegistry (empty — the foundation phase)', () => {
  const registry = new OAuthProviderRegistry();

  it('resolves nothing: has() is false and listProviders() is empty', () => {
    expect(registry.has('github')).toBe(false);
    expect(registry.listProviders()).toEqual([]);
  });

  it('fails closed with the SAME undifferentiated error for unregistered and malformed slugs', () => {
    for (const slug of ['github', 'Not-A-Valid-Slug!']) {
      const error = caught<OAuthProviderError>(() => registry.get(slug));
      expect(error).toBeInstanceOf(OAuthProviderError);
      expect(error.message).toBe('unknown OAuth provider');
      expect(error.details).toEqual({ reason: 'unknown_provider' });
      expect(error.retryable).toBe(false);
    }
  });
});

describe('OAuthProviderRegistry (one config)', () => {
  const registry = new OAuthProviderRegistry([demoConfig]);

  it('resolves a registered slug and lists it', () => {
    expect(registry.has('demo')).toBe(true);
    expect(registry.get('demo')).toBe(demoConfig);
    expect(registry.listProviders()).toEqual(['demo']);
  });

  it('still fails closed for a different, unregistered slug', () => {
    expect(registry.has('github')).toBe(false);
    expect(() => registry.get('github')).toThrow(OAuthProviderError);
  });
});

describe('buildAuthorizationUrl', () => {
  const build = (scopes?: readonly string[]): string =>
    buildAuthorizationUrl({
      config: demoConfig,
      redirectUri: 'https://app.example/oauth/demo/callback',
      state: 'opaque-state-value',
      codeChallenge: 'the-code-challenge',
      ...(scopes !== undefined ? { scopes } : {}),
    });

  it('sets the fixed authorization-code + PKCE(S256) params', () => {
    const params = new URL(build()).searchParams;
    expect(params.get('response_type')).toBe('code');
    expect(params.get('client_id')).toBe('client-id-123');
    expect(params.get('redirect_uri')).toBe('https://app.example/oauth/demo/callback');
    expect(params.get('state')).toBe('opaque-state-value');
    expect(params.get('code_challenge')).toBe('the-code-challenge');
    expect(params.get('code_challenge_method')).toBe('S256');
  });

  it('defaults scopes to the provider config, and an override replaces them', () => {
    expect(new URL(build()).searchParams.get('scope')).toBe('read write');
    expect(new URL(build(['repo', 'user:email'])).searchParams.get('scope')).toBe('repo user:email');
  });

  it('omits the scope param entirely when the override is an empty array', () => {
    expect(new URL(build([])).searchParams.has('scope')).toBe(false);
  });

  it('never leaks the client secret, and percent-encodes every value', () => {
    const url = build();
    expect(url).not.toContain('super-secret-value');
    // The redirect URI's `://` and `/` are percent-encoded in the raw string...
    expect(url).toContain('redirect_uri=https%3A%2F%2Fapp.example');
    // ...and round-trip back to the exact value through the parser.
    expect(new URL(url).searchParams.get('redirect_uri')).toBe('https://app.example/oauth/demo/callback');
  });
});
