/**
 * The allowlisted OAuth provider registry (state design §8) and the pure builder
 * for an authorization-request URL.
 *
 * THREAT. The `:provider` path segment on both the authorize and callback routes
 * is attacker-controlled. If a provider slug were ever turned into an endpoint
 * URL by concatenation — or if an arbitrary URL from the request were trusted —
 * we would have an SSRF/open-redirect primitive. So provider identity is resolved
 * ONLY through this registry: a fixed map from a validated slug to a fully
 * server-configured {@link OAuthProviderConfig}. A slug that is not a registered
 * key fails closed with {@link OAuthProviderError}; there is no fallback and no
 * way to inject an endpoint from request input.
 *
 * PROVIDER-NEUTRAL BY CONSTRUCTION (state design §13). No concrete provider is
 * baked in here. In this foundation phase the registry is empty — every provider
 * lookup fails closed — and a real provider (GitHub, Google, …) is added later by
 * registering its config from server configuration, with no change to this file
 * or to anything downstream of it.
 *
 * `clientSecret` lives on the config but is never logged; {@link listProviders}
 * and every diagnostic here expose only slugs and endpoints.
 */

import { OAuthProviderError } from '@/oauth/errors.js';
import { CODE_CHALLENGE_METHOD } from '@/oauth/pkce.js';

/** A provider slug: lowercase, starts with a letter, short. Validated before any lookup. */
const PROVIDER_SLUG_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

/** Whether a request-supplied provider slug is even shaped like a registry key. */
export function isValidProviderSlug(value: string): boolean {
  return PROVIDER_SLUG_PATTERN.test(value);
}

/**
 * Everything the server needs to run one provider's authorization-code flow. All
 * fields are server-configured; none are ever taken from request input.
 */
export interface OAuthProviderConfig {
  /** Stable registry key, e.g. `github`. Matches the `:provider` route segment. */
  readonly provider: string;
  /** Absolute https URL the browser is sent to for consent. */
  readonly authorizationEndpoint: string;
  /** Absolute https URL for the code→token and refresh exchanges. */
  readonly tokenEndpoint: string;
  /** Absolute https URL for token revocation, when the provider offers one. */
  readonly revocationEndpoint?: string;
  /** The registered OAuth client identifier. */
  readonly clientId: string;
  /** The registered OAuth client secret. Secret — never logged. */
  readonly clientSecret: string;
  /** Default scopes requested when a caller names none. */
  readonly scopes: readonly string[];
}

/**
 * A fail-closed allowlist. Constructed from a fixed set of configs (empty in the
 * foundation phase); an unregistered slug always throws rather than degrading to
 * a default.
 */
export class OAuthProviderRegistry {
  private readonly byProvider: ReadonlyMap<string, OAuthProviderConfig>;

  constructor(configs: readonly OAuthProviderConfig[] = []) {
    this.byProvider = new Map(configs.map((c) => [c.provider, c]));
  }

  /** Whether a slug resolves to a registered provider. Never throws. */
  has(provider: string): boolean {
    return isValidProviderSlug(provider) && this.byProvider.has(provider);
  }

  /**
   * Resolve a slug to its config, or fail closed. The same {@link OAuthProviderError}
   * is raised for a malformed slug and for a well-formed but unregistered one, so
   * probing the route cannot enumerate which providers exist.
   */
  get(provider: string): OAuthProviderConfig {
    const config = isValidProviderSlug(provider) ? this.byProvider.get(provider) : undefined;
    if (config === undefined) {
      throw new OAuthProviderError('unknown OAuth provider', 'unknown_provider');
    }
    return config;
  }

  /** Registered slugs (never secrets), for boot logging and diagnostics. */
  listProviders(): string[] {
    return [...this.byProvider.keys()];
  }
}

/** The inputs to a single authorization-request URL. All derived server-side. */
export interface AuthorizationUrlParams {
  readonly config: OAuthProviderConfig;
  /** The EXACT registered redirect URI (state design §7); never Host-derived. */
  readonly redirectUri: string;
  readonly state: string;
  readonly codeChallenge: string;
  /** Overrides the provider's default scopes when present. */
  readonly scopes?: readonly string[];
}

/**
 * Build the provider's authorization URL with PKCE (`S256`) and the opaque state.
 * Pure and side-effect free; `URLSearchParams` percent-encodes every value, so a
 * scope or redirect URI cannot break out of its parameter.
 */
export function buildAuthorizationUrl(params: AuthorizationUrlParams): string {
  const url = new URL(params.config.authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', params.config.clientId);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('state', params.state);
  url.searchParams.set('code_challenge', params.codeChallenge);
  url.searchParams.set('code_challenge_method', CODE_CHALLENGE_METHOD);
  const scopes = params.scopes ?? params.config.scopes;
  if (scopes.length > 0) {
    url.searchParams.set('scope', scopes.join(' '));
  }
  return url.toString();
}
