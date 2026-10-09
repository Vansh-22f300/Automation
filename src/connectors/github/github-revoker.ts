/**
 * The GitHub token revoker — the provider-side half of disconnect.
 *
 * {@link OAuthService.disconnect} calls `revoke` (best-effort) and then disables the
 * local row. This implementation makes a REAL revocation call rather than faking one:
 * it resolves and decrypts the connection's current access token and asks GitHub to
 * delete it via the app's token-revocation endpoint (`DELETE
 * /applications/{client_id}/token`, HTTP Basic `client_id:client_secret`).
 *
 * BEST-EFFORT BY CONTRACT. It never throws: a failed or unreachable revoke must not
 * block the local disconnect, which disables the connection regardless. The client
 * secret is used only to build the Basic header here (server-only) and is never
 * logged; the access token is sent only in the request body and never logged.
 *
 * KNOWN LIMITATION. Deleting the app token revokes the current ACCESS token. GitHub's
 * authorization grant (and any still-valid refresh token) is a separate object; a
 * fuller teardown would delete the grant (`DELETE /applications/{client_id}/grant`).
 * The connection is always disabled locally, so the credential can no longer be used
 * from this platform either way. See docs/connectors/github.md.
 */

import type { OAuthProviderRegistry } from '@/oauth/provider-config.js';
import { GITHUB_PROVIDER } from '@/oauth/providers/index.js';
import type { RevokeTokenRequest, TokenRevoker } from '@/oauth/token-source.js';
import type { Logger } from '@/observability/logger.js';
import type { ConnectionRepository } from '@/repositories/connection-repository.js';

import {
  DEFAULT_GITHUB_TIMEOUT_MS,
  GITHUB_ACCEPT,
  GITHUB_API_VERSION,
  GITHUB_USER_AGENT,
} from './github-client.js';
import type { FetchLike } from './github-client.js';

export interface GithubTokenRevokerOptions {
  readonly registry: OAuthProviderRegistry;
  /** Builds a tenant-scoped repository to resolve/decrypt the token to revoke. */
  readonly connectionRepositoryFor: (tenantId: string) => ConnectionRepository;
  readonly fetch?: FetchLike;
  readonly timeoutMs?: number;
  readonly logger?: Logger;
}

export class GithubTokenRevoker implements TokenRevoker {
  private readonly registry: OAuthProviderRegistry;
  private readonly connectionRepositoryFor: (tenantId: string) => ConnectionRepository;
  private readonly fetchFn: FetchLike;
  private readonly timeoutMs: number;
  private readonly logger: Logger | undefined;

  constructor(options: GithubTokenRevokerOptions) {
    this.registry = options.registry;
    this.connectionRepositoryFor = options.connectionRepositoryFor;
    this.fetchFn = options.fetch ?? (globalThis.fetch as FetchLike);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_GITHUB_TIMEOUT_MS;
    this.logger = options.logger;
  }

  async revoke(request: RevokeTokenRequest): Promise<void> {
    // Only GitHub, and only when a revocation endpoint is configured. Anything else
    // is a silent no-op so this can sit as the single revoker without surprises.
    if (request.provider !== GITHUB_PROVIDER) return;
    try {
      const config = this.registry.get(request.provider);
      if (config.revocationEndpoint === undefined) return;

      const repository = this.connectionRepositoryFor(request.tenantId);
      const resolved = await repository.resolveForTool({
        provider: request.provider,
        connectionId: request.connectionId,
      });
      const accessToken = resolved.credential['accessToken'];
      if (typeof accessToken !== 'string' || accessToken.length === 0) return;

      const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`, 'utf8').toString('base64');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        // Status is intentionally not inspected: 204 (revoked) and 404/422 (already
        // gone or invalid) are all acceptable terminal states for a best-effort revoke.
        const response = await this.fetchFn(config.revocationEndpoint, {
          method: 'DELETE',
          headers: {
            accept: GITHUB_ACCEPT,
            authorization: `Basic ${basic}`,
            'content-type': 'application/json',
            'x-github-api-version': GITHUB_API_VERSION,
            'user-agent': GITHUB_USER_AGENT,
          },
          body: JSON.stringify({ access_token: accessToken }),
          signal: controller.signal,
        });
        // Drain the body so the underlying connection is released promptly (undici
        // keeps the socket until the body is consumed). Best-effort; content ignored.
        try {
          await response.text?.();
        } catch {
          // draining is hygiene only
        }
      } finally {
        clearTimeout(timer);
      }
      this.logger?.info(
        { provider: request.provider, connection_id: request.connectionId },
        'github_token_revoked',
      );
    } catch (error) {
      // Swallow: provider-side revoke is best-effort. Log a safe label only — never
      // the token, never the response body, never the error's cause chain.
      this.logger?.warn(
        {
          provider: request.provider,
          connection_id: request.connectionId,
          error_name: error instanceof Error ? error.name : 'unknown',
        },
        'github_token_revoke_failed',
      );
    }
  }
}
