/**
 * Integration tests for the session layer — these require a real PostgreSQL.
 *
 * SKIPPED unless `TEST_DATABASE_URL` is set; never faked. If the variable is
 * absent the suite reports skipped, not passed.
 *
 *   TEST_DATABASE_URL=postgresql://.../ai_workforce_test pnpm test
 *
 * What these cover that the offline unit tests cannot:
 *   - the generated migration creates `sessions` with token_hash / expires_at /
 *     revoked_at and no plaintext token column;
 *   - `findActiveByTokenHash` filters revoked and expired rows *in SQL* (via
 *     `revoked_at IS NULL` and `expires_at > now()`) — the one guarantee the
 *     in-memory fake in the unit test cannot prove;
 *   - the composite FK really binds a session to its membership, so the join
 *     returns the membership status/role;
 *   - a real token round-trips through the real authenticator, and an expired,
 *     revoked, or disabled-membership session is refused with UnauthorizedError.
 *
 * The suite writes and deletes rows, so `support.ts` refuses any database whose
 * name does not contain "test".
 */

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { UnauthorizedError } from '@/api/errors.js';
import { SessionAuthenticator } from '@/auth/session-authenticator.js';
import { DrizzleSessionStore } from '@/auth/session-store.js';
import { generateSessionToken, hashSessionToken } from '@/auth/session-token.js';
import type { DatabaseHandle } from '@/db/client.js';
import { memberships, sessions, tenants, users } from '@/db/schema.js';

import { TEST_DATABASE_URL, createTestDatabaseHandle } from './support.js';

const HOUR_MS = 3_600_000;

describe.skipIf(TEST_DATABASE_URL === undefined)('session integration', () => {
  let handle: DatabaseHandle;
  let store: DrizzleSessionStore;
  let tenantActive: string;
  let tenantDisabled: string;
  let userId: string;

  // Mint a session row for (tenant, current user); returns plaintext + hash + id.
  const createSession = async (
    tenantId: string,
    opts: { expiresAt?: Date } = {},
  ): Promise<{ token: string; tokenHash: string; id: string }> => {
    const token = generateSessionToken();
    const tokenHash = hashSessionToken(token);
    const { id } = await store.create({
      tenantId,
      userId,
      tokenHash,
      expiresAt: opts.expiresAt ?? new Date(Date.now() + HOUR_MS),
    });
    return { token, tokenHash, id };
  };

  beforeAll(async () => {
    handle = createTestDatabaseHandle();
    await handle.verifyConnection();
    store = new DrizzleSessionStore(handle.db);

    const insertedTenants = await handle.db
      .insert(tenants)
      .values([{ name: 'Session Tenant Active' }, { name: 'Session Tenant Disabled' }])
      .returning({ id: tenants.id });
    tenantActive = insertedTenants[0]!.id;
    tenantDisabled = insertedTenants[1]!.id;

    const email = `sessions-it-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;
    const [user] = await handle.db.insert(users).values({ email }).returning({ id: users.id });
    userId = user!.id;

    // The same person is an active member of one tenant and a disabled member of
    // another — enough to exercise both membership outcomes without a 2nd user.
    await handle.db.insert(memberships).values([
      { tenantId: tenantActive, userId, role: 'member', status: 'active' },
      { tenantId: tenantDisabled, userId, role: 'member', status: 'disabled' },
    ]);
  });

  afterAll(async () => {
    if (handle === undefined) return;
    // Deleting the tenants cascades memberships → sessions; then the global user.
    for (const id of [tenantActive, tenantDisabled]) {
      if (id !== undefined) await handle.db.delete(tenants).where(eq(tenants.id, id));
    }
    if (userId !== undefined) await handle.db.delete(users).where(eq(users.id, userId));
    await handle.close();
  });

  it('created the sessions table via the migration', async () => {
    const result = await handle.pool.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'sessions'
        order by column_name`,
    );
    const columns = result.rows.map((r) => r.column_name);
    expect(columns).toContain('token_hash');
    expect(columns).toContain('expires_at');
    expect(columns).toContain('revoked_at');
    // No plaintext-bearing column exists at all.
    expect(columns).not.toContain('token');
    expect(columns).not.toContain('secret');
    expect(columns).not.toContain('plaintext');
  });

  it('persists only the token hash, never the plaintext token', async () => {
    const { token, id } = await createSession(tenantActive);

    const [row] = await handle.db.select().from(sessions).where(eq(sessions.id, id));

    expect(row).toBeDefined();
    expect(row!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(token);
  });

  it('resolves a live session, returning tenant, user, and membership status/role', async () => {
    const { tokenHash } = await createSession(tenantActive);

    const record = await store.findActiveByTokenHash(tokenHash);

    expect(record).not.toBeNull();
    expect(record!.tenantId).toBe(tenantActive);
    expect(record!.userId).toBe(userId);
    expect(record!.membershipStatus).toBe('active');
    expect(record!.membershipRole).toBe('member');
  });

  it('returns null for an unknown token hash', async () => {
    const record = await store.findActiveByTokenHash(hashSessionToken(generateSessionToken()));
    expect(record).toBeNull();
  });

  it('filters an expired session in SQL (expires_at > now())', async () => {
    const { tokenHash } = await createSession(tenantActive, {
      expiresAt: new Date(Date.now() - HOUR_MS),
    });
    expect(await store.findActiveByTokenHash(tokenHash)).toBeNull();
  });

  it('filters a revoked session in SQL (revoked_at IS NULL)', async () => {
    const { tokenHash } = await createSession(tenantActive);
    expect(await store.findActiveByTokenHash(tokenHash)).not.toBeNull(); // live before revoke

    await store.revoke(tokenHash);

    expect(await store.findActiveByTokenHash(tokenHash)).toBeNull();
    // revoke recorded a timestamp rather than deleting the row.
    const [row] = await handle.db
      .select({ revokedAt: sessions.revokedAt })
      .from(sessions)
      .where(eq(sessions.tokenHash, tokenHash));
    expect(row!.revokedAt).not.toBeNull();
  });

  it('revoke is idempotent and preserves the original revocation time', async () => {
    const { tokenHash } = await createSession(tenantActive);
    await store.revoke(tokenHash);
    const [first] = await handle.db
      .select({ revokedAt: sessions.revokedAt })
      .from(sessions)
      .where(eq(sessions.tokenHash, tokenHash));

    await store.revoke(tokenHash); // second logout — a no-op on the timestamp

    const [second] = await handle.db
      .select({ revokedAt: sessions.revokedAt })
      .from(sessions)
      .where(eq(sessions.tokenHash, tokenHash));
    expect(second!.revokedAt).toEqual(first!.revokedAt);
  });

  it('revokeAllForUser revokes every live session for that member', async () => {
    const a = await createSession(tenantActive);
    const b = await createSession(tenantActive);

    await store.revokeAllForUser(tenantActive, userId);

    expect(await store.findActiveByTokenHash(a.tokenHash)).toBeNull();
    expect(await store.findActiveByTokenHash(b.tokenHash)).toBeNull();
  });

  it('surfaces a disabled membership on the returned record', async () => {
    const { tokenHash } = await createSession(tenantDisabled);
    const record = await store.findActiveByTokenHash(tokenHash);
    expect(record!.membershipStatus).toBe('disabled');
  });

  it('authenticates a real token to its tenant and user', async () => {
    const { token } = await createSession(tenantActive);
    const auth = new SessionAuthenticator(store);

    const context = await auth.authenticate(token);

    expect(context).toEqual({ tenantId: tenantActive, userId });
  });

  it('refuses an expired session through the authenticator', async () => {
    const { token } = await createSession(tenantActive, {
      expiresAt: new Date(Date.now() - HOUR_MS),
    });
    const auth = new SessionAuthenticator(store);
    await expect(auth.authenticate(token)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('refuses a revoked session through the authenticator', async () => {
    const { token, tokenHash } = await createSession(tenantActive);
    await store.revoke(tokenHash);
    const auth = new SessionAuthenticator(store);
    await expect(auth.authenticate(token)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('refuses a session whose membership is disabled', async () => {
    const { token } = await createSession(tenantDisabled);
    const auth = new SessionAuthenticator(store);
    await expect(auth.authenticate(token)).rejects.toBeInstanceOf(UnauthorizedError);
  });
});
