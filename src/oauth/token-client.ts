/**
 * The code→token and refresh exchanges — the only place an OAuth token request
 * leaves this service.
 *
 * Like the Slack client, this is a confined seam, not a general HTTP layer: it
 * POSTs form-encoded params to a provider's *configured* token endpoint (never a
 * request-supplied URL), authenticates with `client_secret_post`, and bounds every
 * call with an {@link AbortController} timeout so a hung provider surfaces as a
 * retryable failure rather than pinning the request.
 *
 * SECRET DISCIPLINE (state design §9). The client secret, the authorization code,
 * the verifier, and the returned tokens travel only inside the request/response
 * here and are NEVER logged — this module does no logging at all. On any error it
 * throws a classified {@link OAuthProviderError}/{@link OAuthProviderUnavailableError}
 * carrying at most a sanitised `error` token, never the raw body.
 */

import { classifyTokenEndpointError, OAuthProviderError, OAuthProviderUnavailableError } from '@/oauth/errors.js';
import type { OAuthProviderConfig } from '@/oauth/provider-config.js';

/** The `fetch` surface we use, so a test can inject a stub without DOM types. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** Per-request ceiling; a hung token endpoint aborts and becomes retryable. */
export const DEFAULT_OAUTH_TIMEOUT_MS = 10_000;

/** A provider's token response, normalised and stripped to what we persist. */
export interface OAuthTokenSet {
  readonly accessToken: string;
  readonly tokenType: string;
  readonly refreshToken?: string;
  readonly scope?: string;
  /** Absolute expiry derived from `expires_in` at receipt; absent if none given. */
  readonly expiresAt?: Date;
  /**
   * Absolute refresh-token expiry derived from `refresh_token_expires_in` at
   * receipt; absent if the provider issues non-expiring refresh tokens (or none).
   * GitHub only sends this when the OAuth App has token expiration enabled.
   */
  readonly refreshTokenExpiresAt?: Date;
}

/** Only the fields we read from the provider's JSON; everything else is ignored. */
interface RawTokenResponse {
  readonly access_token?: unknown;
  readonly token_type?: unknown;
  readonly expires_in?: unknown;
  readonly refresh_token?: unknown;
  readonly refresh_token_expires_in?: unknown;
  readonly scope?: unknown;
  readonly error?: unknown;
}

export interface ExchangeCodeInput {
  readonly config: OAuthProviderConfig;
  readonly code: string;
  /** MUST be the exact redirect URI sent on the authorize request. */
  readonly redirectUri: string;
  readonly codeVerifier: string;
}

export interface RefreshInput {
  readonly config: OAuthProviderConfig;
  readonly refreshToken: string;
}

export interface OAuthTokenClientOptions {
  /** Injectable fetch (defaults to the global). */
  readonly fetch?: FetchLike;
  readonly timeoutMs?: number;
  /** Clock for computing `expiresAt`; injectable for deterministic tests. */
  readonly now?: () => number;
}

export class OAuthTokenClient {
  private readonly fetchFn: FetchLike;
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(options: OAuthTokenClientOptions = {}) {
    this.fetchFn = options.fetch ?? (globalThis.fetch as FetchLike);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_OAUTH_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
  }

  /** Exchange an authorization code (plus the PKCE verifier) for tokens. */
  async exchangeCode(input: ExchangeCodeInput): Promise<OAuthTokenSet> {
    return this.post(input.config, {
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.redirectUri,
      client_id: input.config.clientId,
      client_secret: input.config.clientSecret,
      code_verifier: input.codeVerifier,
    });
  }

  /** Redeem a refresh token for a fresh access token. */
  async refresh(input: RefreshInput): Promise<OAuthTokenSet> {
    return this.post(input.config, {
      grant_type: 'refresh_token',
      refresh_token: input.refreshToken,
      client_id: input.config.clientId,
      client_secret: input.config.clientSecret,
    });
  }

  private async post(
    config: OAuthProviderConfig,
    fields: Record<string, string>,
  ): Promise<OAuthTokenSet> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let status: number;
    let parsed: RawTokenResponse | undefined;
    try {
      const response = await this.fetchFn(config.tokenEndpoint, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
        },
        body: new URLSearchParams(fields).toString(),
        signal: controller.signal,
      });
      status = response.status;
      // A parse failure yields `undefined`, handled below as malformed — it never
      // escapes as the network error caught in the `catch`.
      parsed = (await response.json().catch(() => undefined)) as RawTokenResponse | undefined;
    } catch (error) {
      throw new OAuthProviderUnavailableError(
        'the OAuth token request could not be completed',
        'network_error',
        error,
      );
    } finally {
      clearTimeout(timer);
    }

    if (status < 200 || status >= 300) {
      throw classifyTokenEndpointError({
        status,
        errorCode: typeof parsed?.error === 'string' ? parsed.error : undefined,
      });
    }
    if (parsed === undefined || typeof parsed.access_token !== 'string' || parsed.access_token.length === 0) {
      throw new OAuthProviderError('the OAuth provider returned a malformed token response', 'malformed_response');
    }
    return this.normalize(parsed);
  }

  private normalize(raw: RawTokenResponse): OAuthTokenSet {
    const refreshToken = typeof raw.refresh_token === 'string' ? raw.refresh_token : undefined;
    const scope = typeof raw.scope === 'string' ? raw.scope : undefined;
    const expiresAt =
      typeof raw.expires_in === 'number' && Number.isFinite(raw.expires_in)
        ? new Date(this.now() + raw.expires_in * 1000)
        : undefined;
    const refreshTokenExpiresAt =
      typeof raw.refresh_token_expires_in === 'number' && Number.isFinite(raw.refresh_token_expires_in)
        ? new Date(this.now() + raw.refresh_token_expires_in * 1000)
        : undefined;
    return {
      accessToken: raw.access_token as string,
      tokenType: typeof raw.token_type === 'string' ? raw.token_type : 'bearer',
      ...(refreshToken !== undefined ? { refreshToken } : {}),
      ...(scope !== undefined ? { scope } : {}),
      ...(expiresAt !== undefined ? { expiresAt } : {}),
      ...(refreshTokenExpiresAt !== undefined ? { refreshTokenExpiresAt } : {}),
    };
  }
}
