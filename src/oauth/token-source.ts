/**
 * The provider-neutral token seam (state design §12/§13): how a stored OAuth
 * credential yields a *currently valid* access token, and how a connection is
 * revoked — both defined as interfaces with default implementations, so a
 * concrete provider can be added later without touching the callers.
 *
 * {@link TokenSource} is what a downstream connector will depend on. The default
 * {@link RefreshingTokenSource} implements the only policy this platform needs:
 * pass the stored access token through while it is still valid, and transparently
 * refresh it (via {@link OAuthTokenClient}) when it is at or past expiry — surfacing
 * the rotated token set so the caller can persist it. A credential with no known
 * expiry is treated as valid (the provider issued no lifetime); an expired one
 * with no refresh token is a permanent, non-refreshable failure.
 *
 * {@link TokenRevoker} is the disconnect seam. No provider has a revocation
 * endpoint wired in this phase, so the default {@link NoopTokenRevoker} is a
 * deliberate no-op: disconnect still removes the local connection, and a real
 * revoker slots in per-provider later. Neither type logs a token.
 */

import { OAuthProviderError } from '@/oauth/errors.js';
import type { OAuthProviderRegistry } from '@/oauth/provider-config.js';
import type { OAuthTokenClient, OAuthTokenSet } from '@/oauth/token-client.js';

/** How a token set is persisted inside a connection's encrypted credential JSON. */
export interface OAuthCredential {
  readonly accessToken: string;
  readonly tokenType: string;
  readonly refreshToken?: string;
  readonly scope?: string;
  /** ISO-8601 absolute expiry as stored; parsed to judge validity. */
  readonly expiresAt?: string;
}

/** Flatten a freshly-obtained token set into the persisted credential shape. */
export function serializeTokenSet(tokenSet: OAuthTokenSet): OAuthCredential {
  return {
    accessToken: tokenSet.accessToken,
    tokenType: tokenSet.tokenType,
    ...(tokenSet.refreshToken !== undefined ? { refreshToken: tokenSet.refreshToken } : {}),
    ...(tokenSet.scope !== undefined ? { scope: tokenSet.scope } : {}),
    ...(tokenSet.expiresAt !== undefined ? { expiresAt: tokenSet.expiresAt.toISOString() } : {}),
  };
}

export interface AccessTokenRequest {
  readonly provider: string;
  readonly credential: OAuthCredential;
}

/** A usable access token, plus the rotated set to persist when a refresh occurred. */
export interface AccessTokenResult {
  readonly accessToken: string;
  readonly tokenType: string;
  /** Present ONLY when a refresh happened; the caller should persist it. */
  readonly refreshed?: OAuthTokenSet;
}

/** The seam a connector depends on to obtain a valid access token. */
export interface TokenSource {
  getAccessToken(request: AccessTokenRequest): Promise<AccessTokenResult>;
}

export interface RefreshingTokenSourceOptions {
  /** Refresh this many ms *before* the stated expiry, to avoid edge races. */
  readonly skewMs?: number;
  /** Injectable clock (ms since epoch); defaults to {@link Date.now}. */
  readonly now?: () => number;
}

/** Treat a token as due for refresh a minute before its stated expiry. */
export const DEFAULT_REFRESH_SKEW_MS = 60_000;

/**
 * Passthrough-until-expiry token source. Refresh is delegated to the injected
 * {@link OAuthTokenClient}; the provider config is resolved through the fail-closed
 * registry, so a credential can never drive a request to an unregistered endpoint.
 */
export class RefreshingTokenSource implements TokenSource {
  private readonly skewMs: number;
  private readonly now: () => number;

  constructor(
    private readonly tokenClient: OAuthTokenClient,
    private readonly registry: OAuthProviderRegistry,
    options: RefreshingTokenSourceOptions = {},
  ) {
    this.skewMs = options.skewMs ?? DEFAULT_REFRESH_SKEW_MS;
    this.now = options.now ?? Date.now;
  }

  async getAccessToken(request: AccessTokenRequest): Promise<AccessTokenResult> {
    const { credential } = request;
    if (!this.isExpired(credential)) {
      return { accessToken: credential.accessToken, tokenType: credential.tokenType };
    }
    if (credential.refreshToken === undefined) {
      throw new OAuthProviderError(
        'the stored OAuth token is expired and cannot be refreshed',
        'not_refreshable',
      );
    }
    const config = this.registry.get(request.provider);
    const refreshed = await this.tokenClient.refresh({
      config,
      refreshToken: credential.refreshToken,
    });
    // A provider may omit a new refresh_token (RFC 6749 §5.1); keep the old one.
    const merged: OAuthTokenSet = {
      ...refreshed,
      refreshToken: refreshed.refreshToken ?? credential.refreshToken,
    };
    return { accessToken: merged.accessToken, tokenType: merged.tokenType, refreshed: merged };
  }

  /** No stated expiry → valid; unparseable or within skew of now → expired. */
  private isExpired(credential: OAuthCredential): boolean {
    if (credential.expiresAt === undefined) return false;
    const expiresAtMs = Date.parse(credential.expiresAt);
    if (Number.isNaN(expiresAtMs)) return true;
    return expiresAtMs - this.skewMs <= this.now();
  }
}

/**
 * A reference to the connection being disconnected — NOT the secret. A concrete
 * revoker resolves the token itself (via its own injected resolver) and calls the
 * provider's revocation endpoint; passing a reference keeps credential decryption
 * in the repository that owns it, and means disconnect need not decrypt a secret
 * just to hand it to a no-op.
 */
export interface RevokeTokenRequest {
  readonly provider: string;
  readonly tenantId: string;
  readonly connectionId: string;
}

/** The provider-neutral disconnect seam; best-effort by contract. */
export interface TokenRevoker {
  revoke(request: RevokeTokenRequest): Promise<void>;
}

/**
 * The default revoker: a no-op until a concrete provider wires a revocation
 * endpoint. Disconnect still removes the local connection either way.
 */
export class NoopTokenRevoker implements TokenRevoker {
  async revoke(_request: RevokeTokenRequest): Promise<void> {}
}
