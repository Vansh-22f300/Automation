/**
 * GitHub OAuth App provider wiring.
 *
 * This module is the single source of truth for every GitHub-specific OAuth
 * constant and for turning validated environment configuration into a
 * provider-neutral {@link OAuthProviderConfig}. Both the API server and the
 * worker build their registry from here so the authorize/exchange/refresh and
 * revocation paths can never drift apart.
 *
 * Scopes are deliberately minimal and fixed: `read:user` (identity),
 * `public_repo` (open an issue on a public repository) and `offline_access`
 * (ask GitHub for a refresh token when token expiration is enabled on the
 * app). We intentionally never request the broad `repo` scope.
 */
import type { Env } from '../../config/env.js';
import type { OAuthProviderConfig } from '../provider-config.js';

/** Registry slug for GitHub. Matches {@link PROVIDER_SLUG_PATTERN}. */
export const GITHUB_PROVIDER = 'github';

/** Browser-facing authorize endpoint (lives on github.com, not the API host). */
export const GITHUB_AUTHORIZATION_ENDPOINT = 'https://github.com/login/oauth/authorize';

/** Server-side token exchange + refresh endpoint (also on github.com). */
export const GITHUB_TOKEN_ENDPOINT = 'https://github.com/login/oauth/access_token';

/** Base of the GitHub REST API (identity, issues, token revocation). */
export const GITHUB_API_BASE = 'https://api.github.com';

/**
 * Fixed, minimal scope set. `read:user` for identity, `public_repo` to create
 * issues on public repositories, `offline_access` to receive a refresh token
 * when the app has token expiration enabled. Never `repo`.
 */
export const GITHUB_DEFAULT_SCOPES = ['read:user', 'public_repo', 'offline_access'] as const;

/**
 * Build GitHub's OAuth token-revocation endpoint for a given client id.
 * `DELETE https://api.github.com/applications/{client_id}/token` (HTTP Basic
 * `client_id:client_secret`) deletes a single access token for the app.
 */
export function githubRevocationEndpoint(clientId: string): string {
  return `${GITHUB_API_BASE}/applications/${encodeURIComponent(clientId)}/token`;
}

/**
 * Produce the GitHub {@link OAuthProviderConfig} from validated env, or
 * `undefined` when GitHub is not configured. Invariant 8 in `env.ts`
 * guarantees the id and secret are both-or-neither, so a single presence
 * check is sufficient here.
 */
export function createGithubProviderConfig(
  env: Pick<Env, 'GITHUB_CLIENT_ID' | 'GITHUB_CLIENT_SECRET'>,
): OAuthProviderConfig | undefined {
  const clientId = env.GITHUB_CLIENT_ID;
  const clientSecret = env.GITHUB_CLIENT_SECRET;
  if (clientId === undefined || clientSecret === undefined) {
    return undefined;
  }
  return {
    provider: GITHUB_PROVIDER,
    authorizationEndpoint: GITHUB_AUTHORIZATION_ENDPOINT,
    tokenEndpoint: GITHUB_TOKEN_ENDPOINT,
    revocationEndpoint: githubRevocationEndpoint(clientId),
    clientId,
    clientSecret,
    scopes: GITHUB_DEFAULT_SCOPES,
  };
}
