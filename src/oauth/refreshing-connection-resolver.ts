/**
 * The refreshing connection resolver — the seam that makes OAuth access tokens
 * transparently fresh for tool execution (state design §12 "RefreshingTokenSource
 * wired into the resolver").
 *
 * It implements the same {@link ConnectionResolver} the tool executor already depends
 * on, so NOTHING downstream changes: the executor still calls `resolveForTool`, and a
 * connector still reads `connection.credential.accessToken`. The difference is what
 * happens in between — for an OAuth-shaped credential this resolver:
 *
 *   1. resolves the connection WITH its encrypted envelope (for the CAS token);
 *   2. asks the {@link TokenSource} for a usable access token, which refreshes when
 *      the stored one is at/near expiry;
 *   3. if a refresh happened, persists the rotated set with a compare-and-swap keyed
 *      on the ciphertext it read — so under concurrency exactly ONE writer wins and a
 *      loser ADOPTS the winner's freshly-persisted credential instead of reusing a
 *      refresh token GitHub has already rotated away.
 *   4. if the refresh ITSELF fails (a concurrent worker rotated the token before this
 *      one's network call), re-reads once; when the stored credential changed under
 *      it, retries with the newly-persisted token rather than surfacing a failure for
 *      a refresh token that is no longer current.
 *
 * The network refresh happens OUTSIDE any DB transaction (the CAS takes only a short
 * row lock to compare and write), honouring the repository rule that external calls
 * must not be made while holding a transaction open.
 *
 * It is PROVIDER-NEUTRAL: a credential that is not OAuth-shaped (e.g. a Slack bot
 * token) is passed straight through untouched, so this wrapper is safe to place over
 * every provider's resolution, not just GitHub's.
 */

import type { AuthorizedConnection, ConnectionRef, ConnectionResolver } from '@/domain/connection.js';
import { serializeTokenSet } from '@/oauth/token-source.js';
import type { AccessTokenResult, OAuthCredential, TokenSource } from '@/oauth/token-source.js';
import type {
  AuthorizedConnectionWithEnvelope,
  CredentialSwapOutcome,
} from '@/repositories/connection-repository.js';
import type { CredentialPayload } from '@/security/credential-cipher.js';

/** The narrow slice of the tenant-scoped connection repository this resolver needs. */
export interface RefreshableConnectionStore {
  resolveWithEnvelope(ref: ConnectionRef): Promise<AuthorizedConnectionWithEnvelope>;
  compareAndSwapCredential(
    id: string,
    expectedCt: string,
    credential: CredentialPayload,
  ): Promise<CredentialSwapOutcome>;
}

/** Read an OAuth credential out of a decrypted payload, or undefined if not one. */
function asOAuthCredential(credential: Record<string, unknown>): OAuthCredential | undefined {
  const accessToken = credential['accessToken'];
  const tokenType = credential['tokenType'];
  if (typeof accessToken !== 'string' || accessToken.length === 0) return undefined;
  if (typeof tokenType !== 'string' || tokenType.length === 0) return undefined;
  const refreshToken = credential['refreshToken'];
  const scope = credential['scope'];
  const expiresAt = credential['expiresAt'];
  const refreshTokenExpiresAt = credential['refreshTokenExpiresAt'];
  return {
    accessToken,
    tokenType,
    ...(typeof refreshToken === 'string' ? { refreshToken } : {}),
    ...(typeof scope === 'string' ? { scope } : {}),
    ...(typeof expiresAt === 'string' ? { expiresAt } : {}),
    ...(typeof refreshTokenExpiresAt === 'string' ? { refreshTokenExpiresAt } : {}),
  };
}

export class RefreshingConnectionResolver implements ConnectionResolver {
  constructor(
    private readonly store: RefreshableConnectionStore,
    private readonly tokenSource: TokenSource,
  ) {}

  async resolveForTool(ref: ConnectionRef): Promise<AuthorizedConnection> {
    const first = await this.store.resolveWithEnvelope(ref);
    const oauth = asOAuthCredential(first.credential);
    if (oauth === undefined) {
      // Not an OAuth-shaped credential — nothing to refresh. Hand back the envelope's
      // resolution as a plain AuthorizedConnection (dropping the ciphertext).
      return { metadata: first.metadata, credential: first.credential };
    }

    let resolved = first;
    let result: AccessTokenResult;
    try {
      result = await this.tokenSource.getAccessToken({ provider: ref.provider, credential: oauth });
    } catch (error) {
      // The refresh may have failed because a CONCURRENT worker already rotated (and
      // thereby invalidated) the refresh token we read. Re-read ONCE: if the stored
      // credential changed under us, adopt and retry with it rather than blindly
      // failing on a refresh token that is no longer current — this is the task's
      // "re-read the newly persisted credentials, don't reuse the stale token"
      // invariant for the losing side of a refresh race. If nothing changed, the
      // failure is real (e.g. the refresh token genuinely expired) and surfaces.
      const reread = await this.store.resolveWithEnvelope(ref);
      if (reread.encryptedCredentials.ct === first.encryptedCredentials.ct) throw error;
      const rereadOauth = asOAuthCredential(reread.credential);
      if (rereadOauth === undefined) {
        return { metadata: reread.metadata, credential: reread.credential };
      }
      resolved = reread;
      result = await this.tokenSource.getAccessToken({ provider: ref.provider, credential: rereadOauth });
    }

    if (result.refreshed === undefined) {
      // Still valid; no refresh happened and nothing to persist.
      return { metadata: resolved.metadata, credential: resolved.credential };
    }

    // A refresh occurred — persist it under compare-and-swap on the ciphertext we read.
    const rotated: CredentialPayload = { ...serializeTokenSet(result.refreshed) };
    const outcome = await this.store.compareAndSwapCredential(
      resolved.metadata.id,
      resolved.encryptedCredentials.ct,
      rotated,
    );
    // 'applied'   → we won; use what we wrote.
    // 'superseded'→ a concurrent writer won; ADOPT their freshly-persisted credential.
    // 'missing'   → the row vanished mid-flight; use the fresh token for this one call.
    const credential = outcome.status === 'superseded' ? outcome.credential : rotated;
    return { metadata: resolved.metadata, credential };
  }
}
