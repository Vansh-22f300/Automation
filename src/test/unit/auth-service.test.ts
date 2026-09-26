/**
 * Unit tests for `AuthService` — the framework-free login/logout/current-session
 * use-cases, exercised against in-memory fakes so every security decision is
 * proven with no database, no HTTP, and no real KDF cost.
 *
 * The invariants under test mirror the spec:
 *   - one generic failure for unknown email / wrong password / no credential /
 *     disabled user / no eligible tenant — none distinguishable from another;
 *   - exactly one password verify per attempt that reaches the KDF (real hash or
 *     the fixed dummy), so an unknown email cannot be told from a known one by
 *     timing; and zero verifies when the throttle already tripped;
 *   - the throttle is consulted before verifying, recorded after a failure, and
 *     cleared on success — keyed by the normalised email;
 *   - the tenant is resolved from the user's memberships, never supplied by the
 *     caller: one → session, zero → generic failure, many → selection required
 *     with no session and no tenant identity disclosed;
 *   - logout revokes exactly the presented token's hash and is idempotent.
 */

import { describe, expect, it } from 'vitest';

import { AuthService, SESSION_TTL_MS } from '@/auth/auth-service.js';
import type { AuthLoginRecord, AuthProfile, AuthUserStore } from '@/auth/auth-user-store.js';
import type { LoginThrottle } from '@/auth/login-throttle.js';
import type { PasswordHasher } from '@/auth/password.js';
import type { AuthSessionRecord, NewSessionInput, SessionStore } from '@/auth/session-store.js';
import { hashSessionToken } from '@/auth/session-token.js';

/**
 * A hasher whose stored hash for password `p` is the sentinel `hash:${p}`, so
 * `verify` is a pure equality check with no real KDF — and a call counter, so a
 * test can prove exactly one verify ran (or none). The fixed dummy hash used by
 * the service matches no password here, so an account-less attempt still "spends"
 * one verify that fails, exactly as the timing defence intends.
 */
function makeHasher(): PasswordHasher & { calls: number } {
  return {
    calls: 0,
    async hash(password: string): Promise<string> {
      return `hash:${password}`;
    },
    async verify(passwordHash: string, password: string): Promise<boolean> {
      this.calls += 1;
      return passwordHash === `hash:${password}`;
    },
  };
}

/** Records every lookup so a test can assert the email was normalised first. */
class FakeAuthUserStore implements AuthUserStore {
  private readonly logins = new Map<string, AuthLoginRecord>();
  private readonly profiles = new Map<string, AuthProfile>();
  readonly lookedUp: string[] = [];

  setLogin(normalizedEmail: string, record: AuthLoginRecord): void {
    this.logins.set(normalizedEmail, record);
  }
  setProfile(userId: string, tenantId: string, profile: AuthProfile): void {
    this.profiles.set(`${userId}:${tenantId}`, profile);
  }

  async findLoginByEmail(normalizedEmail: string): Promise<AuthLoginRecord | null> {
    this.lookedUp.push(normalizedEmail);
    return this.logins.get(normalizedEmail) ?? null;
  }
  async findProfile(userId: string, tenantId: string): Promise<AuthProfile | null> {
    return this.profiles.get(`${userId}:${tenantId}`) ?? null;
  }
}

/** Captures each `create` and `revoke`; the authenticator lookup is unused here. */
class FakeSessionStore implements SessionStore {
  readonly created: NewSessionInput[] = [];
  readonly revoked: string[] = [];

  async create(input: NewSessionInput): Promise<{ id: string }> {
    this.created.push(input);
    return { id: 'session-created' };
  }
  async findActiveByTokenHash(_tokenHash: string): Promise<AuthSessionRecord | null> {
    return null;
  }
  async revoke(tokenHash: string): Promise<void> {
    this.revoked.push(tokenHash);
  }
  async revokeAllForUser(_tenantId: string, _userId: string): Promise<void> {}
}

/** Records the order and identifier of every throttle interaction. */
class FakeThrottle implements LoginThrottle {
  throttled = false;
  readonly checked: string[] = [];
  readonly recorded: string[] = [];
  readonly cleared: string[] = [];

  async isThrottled(identifier: string): Promise<boolean> {
    this.checked.push(identifier);
    return this.throttled;
  }
  async recordFailure(identifier: string): Promise<void> {
    this.recorded.push(identifier);
  }
  async clear(identifier: string): Promise<void> {
    this.cleared.push(identifier);
  }
}

interface Harness {
  service: AuthService;
  users: FakeAuthUserStore;
  hasher: PasswordHasher & { calls: number };
  sessions: FakeSessionStore;
  throttle: FakeThrottle;
}

function makeService(): Harness {
  const users = new FakeAuthUserStore();
  const hasher = makeHasher();
  const sessions = new FakeSessionStore();
  const throttle = new FakeThrottle();
  return { service: new AuthService(users, hasher, sessions, throttle), users, hasher, sessions, throttle };
}

/** A default active user with one active membership and a known password. */
function seedSingleTenantUser(users: FakeAuthUserStore, over: Partial<AuthLoginRecord> = {}): void {
  users.setLogin(over.email ?? 'bob@acme.test', {
    userId: over.userId ?? 'user-1',
    email: over.email ?? 'bob@acme.test',
    name: over.name ?? 'Bob',
    userStatus: over.userStatus ?? 'active',
    passwordHash: over.passwordHash === undefined ? 'hash:correct horse' : over.passwordHash,
    activeMemberships: over.activeMemberships ?? [
      { tenantId: 'tenant-1', tenantName: 'Acme', role: 'member' },
    ],
  });
}

describe('AuthService.login — success', () => {
  it('mints a session for an active user with exactly one active membership', async () => {
    const h = makeService();
    seedSingleTenantUser(h.users);

    const before = Date.now();
    const result = await h.service.login('bob@acme.test', 'correct horse');
    const after = Date.now();

    expect(result.kind).toBe('authenticated');
    if (result.kind !== 'authenticated') throw new Error('unreachable');
    expect(result.user).toEqual({ id: 'user-1', email: 'bob@acme.test', name: 'Bob' });
    expect(result.tenant).toEqual({ id: 'tenant-1', name: 'Acme' });
    expect(typeof result.token).toBe('string');
    expect(result.token.length).toBeGreaterThan(0);
    // 24h absolute lifetime, no sliding renewal.
    expect(result.expiresAt.getTime()).toBeGreaterThanOrEqual(before + SESSION_TTL_MS);
    expect(result.expiresAt.getTime()).toBeLessThanOrEqual(after + SESSION_TTL_MS);
  });

  it('persists only the token hash — never the plaintext token', async () => {
    const h = makeService();
    seedSingleTenantUser(h.users);

    const result = await h.service.login('bob@acme.test', 'correct horse');
    if (result.kind !== 'authenticated') throw new Error('unreachable');

    expect(h.sessions.created).toHaveLength(1);
    const stored = h.sessions.created[0]!;
    expect(stored.tokenHash).toBe(hashSessionToken(result.token));
    expect(stored.tokenHash).not.toBe(result.token);
    expect(stored).toMatchObject({ tenantId: 'tenant-1', userId: 'user-1' });
  });

  it('checks the throttle before verifying and clears it on success', async () => {
    const h = makeService();
    seedSingleTenantUser(h.users);

    await h.service.login('bob@acme.test', 'correct horse');

    expect(h.throttle.checked).toEqual(['bob@acme.test']);
    expect(h.hasher.calls).toBe(1);
    expect(h.throttle.cleared).toEqual(['bob@acme.test']);
    expect(h.throttle.recorded).toEqual([]);
  });

  it('normalises the email (trim + lower-case) before lookup and throttling', async () => {
    const h = makeService();
    seedSingleTenantUser(h.users);

    const result = await h.service.login('  Bob@ACME.test  ', 'correct horse');

    expect(result.kind).toBe('authenticated');
    expect(h.users.lookedUp).toEqual(['bob@acme.test']);
    expect(h.throttle.checked).toEqual(['bob@acme.test']);
    expect(h.throttle.cleared).toEqual(['bob@acme.test']);
  });
});

describe('AuthService.login — one indistinguishable failure', () => {
  it('rejects an unknown email as invalid_credentials, still running one verify', async () => {
    const h = makeService();
    // Nothing seeded: the email does not exist.

    const result = await h.service.login('nobody@acme.test', 'whatever');

    expect(result).toEqual({ kind: 'invalid_credentials' });
    // The dummy hash was verified so the KDF cost matches a real account exactly.
    expect(h.hasher.calls).toBe(1);
    expect(h.throttle.recorded).toEqual(['nobody@acme.test']);
    expect(h.sessions.created).toEqual([]);
  });

  it('rejects a wrong password as invalid_credentials and records the failure', async () => {
    const h = makeService();
    seedSingleTenantUser(h.users);

    const result = await h.service.login('bob@acme.test', 'wrong');

    expect(result).toEqual({ kind: 'invalid_credentials' });
    expect(h.hasher.calls).toBe(1);
    expect(h.throttle.recorded).toEqual(['bob@acme.test']);
    expect(h.sessions.created).toEqual([]);
  });

  it('rejects a credential-less account, still spending exactly one verify', async () => {
    const h = makeService();
    seedSingleTenantUser(h.users, { passwordHash: null });

    const result = await h.service.login('bob@acme.test', 'correct horse');

    expect(result).toEqual({ kind: 'invalid_credentials' });
    // Verified against the dummy hash: a null credential is timing-identical.
    expect(h.hasher.calls).toBe(1);
    expect(h.throttle.recorded).toEqual(['bob@acme.test']);
  });

  it('rejects a disabled user as the same invalid_credentials', async () => {
    const h = makeService();
    seedSingleTenantUser(h.users, { userStatus: 'disabled' });

    const result = await h.service.login('bob@acme.test', 'correct horse');

    expect(result).toEqual({ kind: 'invalid_credentials' });
    expect(h.throttle.recorded).toEqual(['bob@acme.test']);
    expect(h.sessions.created).toEqual([]);
  });

  it('rejects a valid password with zero eligible tenants, recording the failure', async () => {
    const h = makeService();
    seedSingleTenantUser(h.users, { activeMemberships: [] });

    const result = await h.service.login('bob@acme.test', 'correct horse');

    expect(result).toEqual({ kind: 'invalid_credentials' });
    // No tenant identity is ever attached to a failure.
    expect(JSON.stringify(result)).not.toContain('tenant');
    expect(h.throttle.recorded).toEqual(['bob@acme.test']);
    expect(h.sessions.created).toEqual([]);
  });
});

describe('AuthService.login — throttle and multi-tenant', () => {
  it('returns rate_limited without verifying when the account is throttled', async () => {
    const h = makeService();
    seedSingleTenantUser(h.users);
    h.throttle.throttled = true;

    const result = await h.service.login('bob@acme.test', 'correct horse');

    expect(result).toEqual({ kind: 'rate_limited' });
    // Gated before the KDF: a correct password cannot bypass the throttle, and it
    // cannot be worn down for free.
    expect(h.hasher.calls).toBe(0);
    expect(h.sessions.created).toEqual([]);
    expect(h.throttle.recorded).toEqual([]);
  });

  it('requires tenant selection for multiple active memberships without minting a session', async () => {
    const h = makeService();
    seedSingleTenantUser(h.users, {
      activeMemberships: [
        { tenantId: 'tenant-1', tenantName: 'Acme', role: 'member' },
        { tenantId: 'tenant-2', tenantName: 'Globex', role: 'owner' },
      ],
    });

    const result = await h.service.login('bob@acme.test', 'correct horse');

    expect(result).toEqual({ kind: 'tenant_selection_required' });
    // Valid credentials: not counted as a failure, but no session and no cleared
    // throttle either — and crucially no tenant names/ids are disclosed.
    expect(h.sessions.created).toEqual([]);
    expect(h.throttle.recorded).toEqual([]);
    expect(h.throttle.cleared).toEqual([]);
    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain('Acme');
    expect(serialised).not.toContain('Globex');
    expect(serialised).not.toContain('tenant-1');
  });
});

describe('AuthService.logout', () => {
  it('revokes exactly the presented token by its hash', async () => {
    const h = makeService();
    const token = 'a-presented-session-token';

    await h.service.logout(token);

    expect(h.sessions.revoked).toEqual([hashSessionToken(token)]);
    // The plaintext is never handed to the store.
    expect(h.sessions.revoked[0]).not.toBe(token);
  });

  it('is idempotent — a repeat logout simply revokes the same hash again', async () => {
    const h = makeService();
    const token = 'a-presented-session-token';

    await h.service.logout(token);
    await h.service.logout(token);

    expect(h.sessions.revoked).toEqual([hashSessionToken(token), hashSessionToken(token)]);
  });
});

describe('AuthService.getCurrentSession', () => {
  it('resolves the safe public identity for a live (user, tenant) pair', async () => {
    const h = makeService();
    h.users.setProfile('user-1', 'tenant-1', {
      user: { id: 'user-1', email: 'bob@acme.test', name: 'Bob' },
      tenant: { id: 'tenant-1', name: 'Acme' },
    });

    const profile = await h.service.getCurrentSession('user-1', 'tenant-1');

    expect(profile).toEqual({
      user: { id: 'user-1', email: 'bob@acme.test', name: 'Bob' },
      tenant: { id: 'tenant-1', name: 'Acme' },
    });
  });

  it('returns null when the identity has vanished under the session', async () => {
    const h = makeService();
    // No profile seeded: the membership/user is gone.
    expect(await h.service.getCurrentSession('user-1', 'tenant-1')).toBeNull();
  });
});

