/**
 * Unit tests for `SessionAuthenticator`.
 *
 * Like `api-key-authenticator.test.ts`, this exercises the security decision
 * point against an in-memory `SessionStore` fake — no database. The store's
 * contract is that `findActiveByTokenHash` returns a row ONLY for a live session
 * (present, not revoked, not expired); the SQL does that filtering. So at the
 * authenticator's level "unknown", "revoked", and "expired" are one and the same
 * input: the store yields null. (That the SQL genuinely filters revoked/expired
 * rows is proven end-to-end against Postgres in `integration/sessions.test.ts`.)
 * The fake therefore models exactly the two inputs the authenticator can see: a
 * live record, or null.
 *
 * Invariant under test: every failure collapses to the same `UnauthorizedError`,
 * and the raw token never reaches the returned context or the thrown error.
 */

import { describe, expect, it } from 'vitest';

import { UnauthorizedError } from '@/api/errors.js';
import { SessionAuthenticator } from '@/auth/session-authenticator.js';
import type {
  AuthSessionRecord,
  NewSessionInput,
  SessionStore,
} from '@/auth/session-store.js';
import { generateSessionToken, hashSessionToken } from '@/auth/session-token.js';

/** In-memory store keyed by token hash; only live sessions are inserted. */
class FakeSessionStore implements SessionStore {
  private readonly active = new Map<string, AuthSessionRecord>();

  setActive(tokenHash: string, record: AuthSessionRecord): void {
    this.active.set(tokenHash, record);
  }

  async create(_input: NewSessionInput): Promise<{ id: string }> {
    return { id: 'unused-in-authenticator-tests' };
  }

  async findActiveByTokenHash(tokenHash: string): Promise<AuthSessionRecord | null> {
    return this.active.get(tokenHash) ?? null;
  }

  async revoke(_tokenHash: string): Promise<void> {}

  async revokeAllForUser(_tenantId: string, _userId: string): Promise<void> {}
}

/** Seed a live session and return its plaintext token. */
function seedLiveSession(
  store: FakeSessionStore,
  over: Partial<AuthSessionRecord> = {},
): string {
  const token = generateSessionToken();
  store.setActive(hashSessionToken(token), {
    id: over.id ?? 'session-1',
    tenantId: over.tenantId ?? 'tenant-1',
    userId: over.userId ?? 'user-1',
    expiresAt: over.expiresAt ?? new Date(Date.now() + 3_600_000),
    membershipStatus: over.membershipStatus ?? 'active',
    membershipRole: over.membershipRole ?? 'member',
  });
  return token;
}

describe('SessionAuthenticator', () => {
  it('resolves a live session to its tenant and user, with no apiKeyId', async () => {
    const store = new FakeSessionStore();
    const token = seedLiveSession(store, { tenantId: 'tenant-1', userId: 'user-1' });
    const auth = new SessionAuthenticator(store);

    const context = await auth.authenticate(token);

    expect(context).toEqual({ tenantId: 'tenant-1', userId: 'user-1' });
    // A session caller acts as a person, not a key — apiKeyId must be absent.
    expect(context.apiKeyId).toBeUndefined();
  });

  it('rejects a token with no live session (unknown/revoked/expired all look identical)', async () => {
    const auth = new SessionAuthenticator(new FakeSessionStore());
    // Well-formed but never stored — indistinguishable from a revoked/expired row.
    await expect(auth.authenticate(generateSessionToken())).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
  });

  it('rejects a live session whose bound membership is disabled', async () => {
    const store = new FakeSessionStore();
    const token = seedLiveSession(store, { membershipStatus: 'disabled' });
    const auth = new SessionAuthenticator(store);

    await expect(auth.authenticate(token)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('takes the tenant solely from the stored row, never from the caller', async () => {
    // authenticate() accepts only an opaque credential — there is no tenant
    // parameter to smuggle in. The resolved tenant is whatever the row is bound to.
    const store = new FakeSessionStore();
    const token = seedLiveSession(store, { tenantId: 'tenant-B', userId: 'user-9' });
    const auth = new SessionAuthenticator(store);

    const context = await auth.authenticate(token);

    expect(context.tenantId).toBe('tenant-B');
  });

  it('never places the raw token or its hash in the returned context', async () => {
    const store = new FakeSessionStore();
    const token = seedLiveSession(store);
    const auth = new SessionAuthenticator(store);

    const context = await auth.authenticate(token);

    const serialised = JSON.stringify(context);
    expect(serialised).not.toContain(token);
    expect(serialised).not.toContain(hashSessionToken(token));
  });

  it('never leaks the raw token in the rejection error', async () => {
    const auth = new SessionAuthenticator(new FakeSessionStore());
    const token = generateSessionToken();

    const error = await auth.authenticate(token).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(UnauthorizedError);
    const err = error as Error;
    expect(`${err.message}\n${err.stack ?? ''}`).not.toContain(token);
  });
});
