/**
 * The GitHub connection finalizer (OAuth callback → identity → connection name).
 *
 * It runs on the API server inside {@link OAuthService.completeCallback}, immediately
 * after a successful code→token exchange, with the freshly-obtained {@link OAuthTokenSet}.
 * It calls GitHub's `GET /user` through the confined transport to establish the
 * authenticated identity, then returns the connection `name` (the GitHub login, so
 * re-authorizing the same account heals one row via the `(tenant, provider, name)`
 * upsert) and non-secret `metadata` (numeric id, login, display name, granted scope).
 *
 * The identity GitHub returns is authoritative. The finalizer NEVER returns or logs a
 * secret — only non-secret descriptors. A failure here throws the OAuth error shapes
 * the callback route already maps safely: a deterministic rejection as
 * {@link OAuthProviderError} (the connection is not persisted), a transient outage as
 * {@link OAuthProviderUnavailableError}.
 */

import { OAuthProviderError, OAuthProviderUnavailableError } from '@/oauth/errors.js';
import type { ConnectionFinalization, ConnectionFinalizer } from '@/oauth/oauth-service.js';
import { GITHUB_PROVIDER } from '@/oauth/providers/index.js';
import type { OAuthTokenSet } from '@/oauth/token-client.js';
import type { Logger } from '@/observability/logger.js';

import type { GithubTransport } from './github-client.js';
import { parseGithubIdentity } from './github-identity.js';

export interface GithubConnectionFinalizerOptions {
  readonly transport: GithubTransport;
  /** Metadata-only logger. The finalizer binds no secret (never the token) to it. */
  readonly logger?: Logger;
}

export class GithubConnectionFinalizer implements ConnectionFinalizer {
  private readonly transport: GithubTransport;
  private readonly logger: Logger | undefined;

  constructor(options: GithubConnectionFinalizerOptions) {
    this.transport = options.transport;
    this.logger = options.logger;
  }

  async finalize(input: { readonly tokenSet: OAuthTokenSet }): Promise<ConnectionFinalization> {
    const { tokenSet } = input;
    let response;
    try {
      response = await this.transport.getAuthenticatedUser(tokenSet.accessToken);
    } catch (cause) {
      // Transport failure: GitHub unreachable/timed out. Transient — a later retry
      // of the (idempotent) identity read could succeed. The token is not in `cause`.
      throw new OAuthProviderUnavailableError(
        'could not reach GitHub to verify the authorized identity',
        'identity_unreachable',
        cause,
      );
    }

    if (response.status < 200 || response.status >= 300) {
      if (response.status === 429 || response.status >= 500) {
        throw new OAuthProviderUnavailableError(
          'GitHub was unavailable while verifying the authorized identity',
          'identity_unavailable',
        );
      }
      // 401/403/404/4xx: the token did not authorize an identity read. Deterministic.
      throw new OAuthProviderError('GitHub rejected the identity request', 'identity_rejected');
    }

    const identity = parseGithubIdentity(response.body);
    if (identity === undefined) {
      throw new OAuthProviderError(
        'GitHub returned an unexpected identity response',
        'identity_malformed',
      );
    }

    this.logger?.info(
      { provider: GITHUB_PROVIDER, github_user_id: identity.id, login: identity.login },
      'github_identity_verified',
    );

    return {
      name: identity.login,
      metadata: {
        provider: GITHUB_PROVIDER,
        githubUserId: identity.id,
        login: identity.login,
        ...(identity.name !== undefined ? { displayName: identity.name } : {}),
        ...(tokenSet.scope !== undefined ? { scope: tokenSet.scope } : {}),
      },
    };
  }
}
