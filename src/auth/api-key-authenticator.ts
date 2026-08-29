/**
 * API-key implementation of the `Authenticator` seam.
 *
 * Given a presented key it resolves the owning tenant, or throws
 * `UnauthorizedError`. Every failure — malformed, unknown, wrong secret, revoked
 * — maps to the same 401 with the same vague message, because distinguishing them
 * to the caller only helps an attacker enumerate keys.
 *
 * Timing discipline: a *known* prefix and an *unknown* prefix should cost roughly
 * the same, or response time would leak which prefixes exist. So even when no row
 * is found we still run a hash verification against a fixed dummy hash before
 * rejecting. It is not perfect constant-time across a database lookup, but it
 * removes the obvious "unknown prefixes return instantly" signal cheaply.
 */

import type { AuthContext, Authenticator } from '@/auth/context.js';
import { hashSecret, parseApiKey, verifySecret } from '@/auth/api-key.js';
import type { ApiKeyStore } from '@/auth/api-key-store.js';
import { UnauthorizedError } from '@/api/errors.js';

/** A fixed hash to compare against when no row matched, to even out timing. */
const DUMMY_HASH = hashSecret('unused-placeholder-secret');

export class ApiKeyAuthenticator implements Authenticator {
  constructor(private readonly store: ApiKeyStore) {}

  async authenticate(credential: string): Promise<AuthContext> {
    const parsed = parseApiKey(credential);
    if (parsed === null) {
      // Structurally not one of our keys. Nothing to look up.
      throw new UnauthorizedError();
    }

    const record = await this.store.findByPrefix(parsed.prefix);

    if (record === null) {
      // Spend the same work we would on a real comparison, then reject.
      verifySecret(parsed.secret, DUMMY_HASH);
      throw new UnauthorizedError();
    }

    if (!verifySecret(parsed.secret, record.keyHash)) {
      throw new UnauthorizedError();
    }

    if (record.revokedAt !== null) {
      throw new UnauthorizedError();
    }

    // Best-effort; a failed touch must never turn a valid request into a 401.
    void this.store.touchLastUsed(record.id).catch(() => undefined);

    return { tenantId: record.tenantId, apiKeyId: record.id };
  }
}
