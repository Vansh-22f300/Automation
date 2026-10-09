/**
 * Unit tests for the token client (`@/oauth/token-client`) — the only place an
 * OAuth token request leaves the service (state design §9). All I/O is stubbed via
 * an injected `fetch`, so these pin: the form-encoded body carries the grant, the
 * client secret, and the PKCE verifier / refresh token; the response is normalised
 * (token-type default, `expiresAt` derived from an injected clock, optionals
 * omitted); and every failure mode maps to a classified error carrying at most a
 * sanitised reason — never the raw body.
 */

import { describe, expect, it } from 'vitest';

import type { AppError } from '@/domain/errors.js';
import { OAuthProviderError, OAuthProviderUnavailableError } from '@/oauth/errors.js';
import type { OAuthProviderConfig } from '@/oauth/provider-config.js';
import { OAuthTokenClient } from '@/oauth/token-client.js';

const config: OAuthProviderConfig = {
  provider: 'demo',
  authorizationEndpoint: 'https://provider.example/authorize',
  tokenEndpoint: 'https://provider.example/token',
  clientId: 'client-id-123',
  clientSecret: 'super-secret-value',
  scopes: ['read'],
};

const REDIRECT_URI = 'https://app.example/oauth/demo/callback';

/** A minimal `Response` stub: only `.status` and `.json()` are read by the client. */
const jsonResponse = (status: number, body: unknown): Response =>
  ({ status, json: async () => body }) as unknown as Response;

/** Capture a rejection so its class, message, and `details` can be asserted. */
const rejected = async (p: Promise<unknown>): Promise<AppError> => {
  try {
    await p;
  } catch (error) {
    return error as AppError;
  }
  throw new Error('expected the promise to reject, but it resolved');
};

const exchange = (client: OAuthTokenClient): Promise<unknown> =>
  client.exchangeCode({ config, code: 'the-code', redirectUri: REDIRECT_URI, codeVerifier: 'the-verifier' });

describe('OAuthTokenClient request bodies', () => {
  it('exchangeCode posts the authorization-code grant with the verifier and secret', async () => {
    let init: RequestInit | undefined;
    const client = new OAuthTokenClient({
      fetch: async (url, requestInit) => {
        expect(url).toBe(config.tokenEndpoint); // the CONFIGURED endpoint, never request input
        init = requestInit;
        return jsonResponse(200, { access_token: 'at' });
      },
    });
    await client.exchangeCode({ config, code: 'the-code', redirectUri: REDIRECT_URI, codeVerifier: 'the-verifier' });
    const body = new URLSearchParams(init!.body as string);
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('the-code');
    expect(body.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(body.get('client_id')).toBe('client-id-123');
    expect(body.get('client_secret')).toBe('super-secret-value');
    expect(body.get('code_verifier')).toBe('the-verifier');
  });

  it('refresh posts the refresh-token grant with the secret', async () => {
    let init: RequestInit | undefined;
    const client = new OAuthTokenClient({
      fetch: async (_url, requestInit) => {
        init = requestInit;
        return jsonResponse(200, { access_token: 'at' });
      },
    });
    await client.refresh({ config, refreshToken: 'the-refresh-token' });
    const body = new URLSearchParams(init!.body as string);
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('the-refresh-token');
    expect(body.get('client_secret')).toBe('super-secret-value');
  });
});

describe('OAuthTokenClient normalization', () => {
  it('maps every field and derives expiresAt from the injected clock', async () => {
    const client = new OAuthTokenClient({
      now: () => 1_000_000,
      fetch: async () =>
        jsonResponse(200, { access_token: 'at', token_type: 'Bearer', expires_in: 3600, refresh_token: 'rt', scope: 'read' }),
    });
    expect(await exchange(client)).toEqual({
      accessToken: 'at',
      tokenType: 'Bearer',
      refreshToken: 'rt',
      scope: 'read',
      expiresAt: new Date(1_000_000 + 3600 * 1000),
    });
  });

  it('defaults token_type to "bearer" and omits absent optionals', async () => {
    const client = new OAuthTokenClient({ fetch: async () => jsonResponse(200, { access_token: 'only-access' }) });
    expect(await exchange(client)).toEqual({ accessToken: 'only-access', tokenType: 'bearer' });
  });

  it('derives refreshTokenExpiresAt from refresh_token_expires_in', async () => {
    const client = new OAuthTokenClient({
      now: () => 1_000_000,
      fetch: async () =>
        jsonResponse(200, {
          access_token: 'at',
          refresh_token: 'rt',
          expires_in: 3600,
          refresh_token_expires_in: 7200,
        }),
    });
    expect(await exchange(client)).toMatchObject({
      refreshTokenExpiresAt: new Date(1_000_000 + 7200 * 1000),
    });
  });
});

describe('OAuthTokenClient failure classification', () => {
  it('maps a 4xx error token to a permanent provider error', async () => {
    const client = new OAuthTokenClient({ fetch: async () => jsonResponse(400, { error: 'invalid_grant' }) });
    const error = await rejected(exchange(client));
    expect(error).toBeInstanceOf(OAuthProviderError);
    expect(error.details).toEqual({ reason: 'invalid_grant' });
  });

  it('maps 429 and 5xx to a retryable unavailable error', async () => {
    for (const status of [429, 500]) {
      const client = new OAuthTokenClient({ fetch: async () => jsonResponse(status, {}) });
      expect(await rejected(exchange(client))).toBeInstanceOf(OAuthProviderUnavailableError);
    }
  });

  it('maps a fetch failure to a retryable network error', async () => {
    const client = new OAuthTokenClient({
      fetch: async () => {
        throw new Error('socket hang up');
      },
    });
    const error = await rejected(exchange(client));
    expect(error).toBeInstanceOf(OAuthProviderUnavailableError);
    expect(error.message).toBe('the OAuth token request could not be completed');
    expect(error.details).toEqual({ reason: 'network_error' });
  });

  it('rejects a 200 with a missing, empty, or non-string access_token as malformed', async () => {
    for (const body of [{}, { access_token: '' }, { access_token: 42 }]) {
      const client = new OAuthTokenClient({ fetch: async () => jsonResponse(200, body) });
      const error = await rejected(exchange(client));
      expect(error).toBeInstanceOf(OAuthProviderError);
      expect(error.details).toEqual({ reason: 'malformed_response' });
    }
  });

  it('treats an unparseable 200 body as malformed, not a network error', async () => {
    const client = new OAuthTokenClient({
      fetch: async () =>
        ({
          status: 200,
          json: async () => {
            throw new Error('invalid json');
          },
        }) as unknown as Response,
    });
    const error = await rejected(exchange(client));
    expect(error).toBeInstanceOf(OAuthProviderError);
    expect(error.details).toEqual({ reason: 'malformed_response' });
  });
});
