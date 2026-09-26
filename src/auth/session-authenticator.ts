/**
 * Session authentication — the second `Authenticator`, alongside the API-key one.
 *
 * It turns a presented session token into an `AuthContext`, or refuses. The
 * decision is deliberately narrow: hash the token, look up the live session by
 * that hash, confirm the person is still an active member of the bound tenant,
 * and return `{ tenantId, userId }`. Nothing here mints, rotates, or clears
 * sessions, and — unlike the future login service — it never touches a password.
 *
 * Security invariants:
 *   - Every failure (unknown token, revoked, expired, disabled membership)
 *     collapses to the same `UnauthorizedError`, so a caller can never tell why
 *     a token was refused, nor probe for which tokens exist.
 *   - The raw token never leaves this method: it is hashed immediately, never
 *     logged, and never placed in the returned context or in any error.
 *   - The tenant comes from the session row (bound by the `sessions →
 *     memberships` composite FK), never from anything the caller supplied.
 *
 * No timing-equalisation dance is needed here, unlike the API-key path. That
 * path fetches a candidate by prefix and then compares a secret, so it must run
 * a dummy compare on a miss to hide "prefix unknown" from "secret wrong". A
 * session is resolved purely by the presence of its token's hash in a unique
 * index — there is no per-row secret comparison whose duration could leak, and
 * the 256-bit token gives an attacker nothing to narrow a search with.
 */

import { UnauthorizedError } from '@/api/errors.js';
import type { AuthContext, Authenticator } from '@/auth/context.js';
import type { SessionStore } from '@/auth/session-store.js';
import { hashSessionToken } from '@/auth/session-token.js';

export class SessionAuthenticator implements Authenticator {
  constructor(private readonly store: SessionStore) {}

  async authenticate(credential: string): Promise<AuthContext> {
    // Hash first; the plaintext token is not used again and never logged.
    const tokenHash = hashSessionToken(credential);

    // Unknown, revoked, and expired all surface as null from the store — one
    // indistinguishable "no live session" outcome.
    const session = await this.store.findActiveByTokenHash(tokenHash);
    if (session === null) {
      throw new UnauthorizedError();
    }

    // The session is live, but the membership it is bound to may since have been
    // disabled. A disabled member is not authenticated — same 401, no detail.
    if (session.membershipStatus !== 'active') {
      throw new UnauthorizedError();
    }

    // Identity comes entirely from the stored row. A session caller has a userId
    // and no apiKeyId; the optional apiKeyId is simply omitted.
    return { tenantId: session.tenantId, userId: session.userId };
  }
}
