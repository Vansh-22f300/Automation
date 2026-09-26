/**
 * Integration tests for the human-authentication API — these require a real
 * PostgreSQL and are SKIPPED (never faked) unless `TEST_DATABASE_URL` is set.
 *
 *   TEST_DATABASE_URL=postgresql://.../ai_workforce_test pnpm test
 *
 * These drive the *assembled* app (`buildApp` + `app.inject`) with the real auth
 * stack wired to Postgres — the real `DrizzleAuthUserStore`, the real Argon2id
 * hasher, the real `DrizzleSessionStore`, the real `DrizzleLoginThrottle`, and
 * both authenticators — so what they prove is the thing the offline unit tests
 * cannot: that login mints a real session row, that logout revokes it in SQL,
 * that `/auth/session` reflects revocation, that the account throttle counts in
 * a shared store, and that the API-key `/v1/*` surface is untouched by any of it.
 *
 * The suite writes and deletes rows (users, memberships, credentials, sessions,
 * login_attempts, api_keys), so `support.ts` refuses any database whose name
 * lacks "test". Every seeded email shares the `@auth-it.test` domain so the
 * throttle rows (which have no FK to cascade) can be cleaned by suffix.
 */

import { eq, like } from 'drizzle-orm';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '@/api/app.js';
import { AuthService } from '@/auth/auth-service.js';
import { DrizzleAuthUserStore } from '@/auth/auth-user-store.js';
import { DrizzleLoginThrottle } from '@/auth/login-throttle.js';
import { argon2PasswordHasher } from '@/auth/password.js';
import { SessionAuthenticator } from '@/auth/session-authenticator.js';
import { DrizzleSessionStore } from '@/auth/session-store.js';
import { hashSessionToken } from '@/auth/session-token.js';
import { ApiKeyAuthenticator } from '@/auth/api-key-authenticator.js';
import { DrizzleApiKeyStore } from '@/auth/api-key-store.js';
import type { ApiServer } from '@/api/types.js';
import type { DatabaseHandle } from '@/db/client.js';
import { loginAttempts, memberships, passwordCredentials, sessions, tenants, users } from '@/db/schema.js';
import { ApiKeyRepository } from '@/repositories/api-key-repository.js';
import { TenantScope } from '@/repositories/tenant-scope.js';

import { TEST_DATABASE_URL, createTestDatabaseHandle } from './support.js';

const PASSWORD = 'correct-horse-battery-staple';
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const email = (who: string): string => `${who}-${RUN}@auth-it.test`;

/** No-op factories for the non-auth surfaces buildApp requires but this suite never drives. */
const unusedFactories = {
  workflowServiceFor: () => ({
    create: async () => { throw new Error('not used'); },
    createVersion: async () => { throw new Error('not used'); },
    activateVersion: async () => { throw new Error('not used'); },
    getWorkflow: async () => { throw new Error('not used'); },
    listVersions: async () => [],
    getActiveVersion: async () => null,
    listWorkflows: async () => ({ items: [], nextCursor: null }),
  }),
  connectionServiceFor: () => ({
    create: async () => { throw new Error('not used'); },
    listMetadata: async () => [],
    listMetadataPage: async () => ({ items: [], nextCursor: null }),
    getMetadata: async () => null,
    updateMetadata: async () => null,
    disable: async () => null,
    delete: async () => false,
    resolveForTool: async () => { throw new Error('not used'); },
  }),
  webhookIngestorFor: () => ({
    ingest: async () => ({ eventId: 'x', runId: null, duplicate: false, workflowConfigured: false }),
  }),
  webhookSignatureResolverFor: () => ({ resolveForSource: async () => null }),
  runInspectionFor: () => ({ getRun: async () => null, listRuns: async () => ({ items: [], nextCursor: null }) }),
};

const bearer = (token: string): { authorization: string } => ({ authorization: `Bearer ${token}` });

describe.skipIf(TEST_DATABASE_URL === undefined)('auth API integration', () => {
  let handle: DatabaseHandle;
  let app: ApiServer;
  let tenantOneId: string;
  let tenantTwoId: string;
  const userIds: string[] = [];

  // Seed one active user with a password credential and the given memberships.
  const seedUser = async (
    who: string,
    passwordHash: string | null,
    memberOf: { tenantId: string }[],
    status: 'active' | 'disabled' = 'active',
  ): Promise<string> => {
    const [user] = await handle.db
      .insert(users)
      .values({ email: email(who), name: who, status })
      .returning({ id: users.id });
    const userId = user!.id;
    userIds.push(userId);
    if (passwordHash !== null) {
      await handle.db.insert(passwordCredentials).values({ userId, passwordHash });
    }
    if (memberOf.length > 0) {
      await handle.db
        .insert(memberships)
        .values(memberOf.map((m) => ({ tenantId: m.tenantId, userId, role: 'member' as const, status: 'active' as const })));
    }
    return userId;
  };

  beforeAll(async () => {
    handle = createTestDatabaseHandle();
    await handle.verifyConnection();

    const insertedTenants = await handle.db
      .insert(tenants)
      .values([{ name: 'Auth Tenant One' }, { name: 'Auth Tenant Two' }])
      .returning({ id: tenants.id });
    tenantOneId = insertedTenants[0]!.id;
    tenantTwoId = insertedTenants[1]!.id;

    const passwordHash = await argon2PasswordHasher.hash(PASSWORD);
    await seedUser('solo', passwordHash, [{ tenantId: tenantOneId }]);
    await seedUser('multi', passwordHash, [{ tenantId: tenantOneId }, { tenantId: tenantTwoId }]);
    await seedUser('nomember', passwordHash, []);
    await seedUser('throttle', passwordHash, [{ tenantId: tenantOneId }]);

    const sessionStore = new DrizzleSessionStore(handle.db);
    app = await buildApp({
      logger: pino({ level: 'silent' }),
      // Real API-key path (regression) and real session path (human auth).
      authenticator: new ApiKeyAuthenticator(new DrizzleApiKeyStore(handle.db)),
      sessionAuthenticator: new SessionAuthenticator(sessionStore),
      authService: new AuthService(
        new DrizzleAuthUserStore(handle.db),
        argon2PasswordHasher,
        sessionStore,
        new DrizzleLoginThrottle(handle.db),
      ),
      checkDatabase: async () => undefined,
      apiKeyServiceFor: (auth) => new ApiKeyRepository(new TenantScope(handle.db, auth.tenantId)),
      // The global per-IP limiter is proven elsewhere; raise it here so the shared
      // inject IP does not collide across this suite's many requests. The account
      // throttle under test is a separate, DB-backed mechanism.
      rateLimit: { max: 10_000 },
      ...unusedFactories,
    });
  });

  afterAll(async () => {
    if (handle === undefined) return;
    if (app !== undefined) await app.close();
    // login_attempts has no FK to cascade — clear this run's rows by email suffix.
    await handle.db.delete(loginAttempts).where(like(loginAttempts.identifier, `%${RUN}@auth-it.test`));
    // Deleting tenants cascades memberships → sessions (and api_keys); users cascade credentials.
    for (const id of [tenantOneId, tenantTwoId]) {
      if (id !== undefined) await handle.db.delete(tenants).where(eq(tenants.id, id));
    }
    for (const id of userIds) {
      await handle.db.delete(users).where(eq(users.id, id));
    }
    await handle.close();
  });

  const login = (payload: unknown) =>
    app.inject({ method: 'POST', url: '/auth/login', payload: payload as never });

  describe('POST /auth/login', () => {
    it('mints a session for a single-tenant user and returns the safe shape', async () => {
      const res = await login({ email: email('solo'), password: PASSWORD });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.user).toMatchObject({ email: email('solo'), name: 'solo' });
      expect(body.tenant).toMatchObject({ id: tenantOneId, name: 'Auth Tenant One' });
      expect(typeof body.session.token).toBe('string');
      expect(typeof body.session.expiresAt).toBe('string');
      // No credential material leaks in the response envelope.
      const raw = res.body;
      expect(raw).not.toContain('passwordHash');
      expect(raw).not.toContain('tokenHash');
      expect(raw).not.toContain('$argon2');

      // A real, hashed session row exists — never the plaintext token.
      const [row] = await handle.db
        .select({ tokenHash: sessions.tokenHash })
        .from(sessions)
        .where(eq(sessions.tokenHash, hashSessionToken(body.session.token)));
      expect(row).toBeDefined();
      expect(JSON.stringify(row)).not.toContain(body.session.token);
    });

    it('returns one generic 401 for a wrong password and an unknown email alike', async () => {
      const wrong = await login({ email: email('solo'), password: 'not-the-password' });
      const unknown = await login({ email: email('ghost'), password: PASSWORD });

      expect(wrong.statusCode).toBe(401);
      expect(unknown.statusCode).toBe(401);
      // Indistinguishable in everything the caller can see — same status, same
      // code, same message. Only the per-request id differs (unique by design),
      // so compare the meaningful envelope rather than the whole body.
      const meaningful = (r: typeof wrong) => ({
        code: r.json().error.code,
        message: r.json().error.message,
      });
      expect(meaningful(wrong)).toEqual(meaningful(unknown));
      expect(wrong.json().error.code).toBe('unauthorized');
    });

    it('requires tenant selection (409) for a multi-tenant account, leaking no tenant identity', async () => {
      const res = await login({ email: email('multi'), password: PASSWORD });

      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('tenant_selection_required');
      expect(res.body).not.toContain('Auth Tenant One');
      expect(res.body).not.toContain('Auth Tenant Two');
      expect(res.body).not.toContain(tenantOneId);
    });

    it('rejects a valid password with no membership as the same generic 401', async () => {
      const res = await login({ email: email('nomember'), password: PASSWORD });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('unauthorized');
    });

    it('rejects a malformed body with 400 before any auth work', async () => {
      const res = await login({ email: 'not-an-email', password: '' });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('bad_request');
    });
  });

  describe('GET /auth/session and POST /auth/logout', () => {
    const freshToken = async (): Promise<string> => {
      const res = await login({ email: email('solo'), password: PASSWORD });
      return res.json().session.token as string;
    };

    it('refuses an unauthenticated session probe with 401', async () => {
      const res = await app.inject({ method: 'GET', url: '/auth/session' });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('unauthorized');
    });

    it('resolves the current session, then refuses the token once logged out', async () => {
      const token = await freshToken();

      const ok = await app.inject({ method: 'GET', url: '/auth/session', headers: bearer(token) });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toEqual({
        user: { id: expect.any(String), email: email('solo'), name: 'solo' },
        tenant: { id: tenantOneId, name: 'Auth Tenant One' },
      });

      const out = await app.inject({ method: 'POST', url: '/auth/logout', headers: bearer(token) });
      expect(out.statusCode).toBe(204);

      // The very same token no longer resolves — revocation is enforced in SQL.
      const after = await app.inject({ method: 'GET', url: '/auth/session', headers: bearer(token) });
      expect(after.statusCode).toBe(401);

      // Re-using the now-revoked token is refused by the session guard (401): the
      // credential is dead, so a second logout never reaches the handler. Service-
      // level idempotency (revoking an already-revoked hash is a safe no-op) is
      // proven in the unit suite; at the HTTP boundary the guard fails closed.
      const again = await app.inject({ method: 'POST', url: '/auth/logout', headers: bearer(token) });
      expect(again.statusCode).toBe(401);
    });

    it('refuses logout without a session credential', async () => {
      const res = await app.inject({ method: 'POST', url: '/auth/logout' });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('account login throttle', () => {
    it('locks the account after repeated failures — even a correct password is refused', async () => {
      const victim = email('throttle');
      for (let i = 0; i < 5; i += 1) {
        const bad = await login({ email: victim, password: 'wrong-password' });
        expect(bad.statusCode).toBe(401);
        expect(bad.json().error.code).toBe('unauthorized');
      }
      // The 6th attempt uses the CORRECT password, yet is refused: the throttle is
      // consulted before the KDF, so a valid credential cannot bypass a locked
      // account — and the lock cannot be worn down for free.
      const sixth = await login({ email: victim, password: PASSWORD });
      expect(sixth.statusCode).toBe(429);
      expect(sixth.json().error.code).toBe('rate_limited');
    });

    it('throttles an unknown email the same way, so the lock is no enumeration oracle', async () => {
      const ghost = email('ghost-throttle');
      for (let i = 0; i < 5; i += 1) {
        const res = await login({ email: ghost, password: 'whatever' });
        expect(res.statusCode).toBe(401);
      }
      const locked = await login({ email: ghost, password: 'whatever' });
      // The very same 429 a known-but-locked account returns — indistinguishable.
      expect(locked.statusCode).toBe(429);
      expect(locked.json().error.code).toBe('rate_limited');
    });
  });

  describe('the API-key surface is untouched by human auth', () => {
    it('still authenticates a real API key on /v1/*, and keeps the two credentials apart', async () => {
      // A genuine key minted the normal way still works on the API-key surface.
      const created = await new ApiKeyRepository(new TenantScope(handle.db, tenantOneId)).create('auth-it regression');
      const okV1 = await app.inject({ method: 'GET', url: '/v1/api-keys', headers: bearer(created.plaintext) });
      expect(okV1.statusCode).toBe(200);

      // A human session token is not a key: it cannot reach the /v1 surface.
      const token = (await login({ email: email('solo'), password: PASSWORD })).json().session.token as string;
      const sessionOnV1 = await app.inject({ method: 'GET', url: '/v1/api-keys', headers: bearer(token) });
      expect(sessionOnV1.statusCode).toBe(401);

      // ...and an API key cannot satisfy a human /auth/* route.
      const keyOnAuth = await app.inject({ method: 'GET', url: '/auth/session', headers: bearer(created.plaintext) });
      expect(keyOnAuth.statusCode).toBe(401);
    });
  });

  describe('login_attempts persistence', () => {
    it('is a real table keyed by identifier that stores no identity or secret material', async () => {
      const result = await handle.pool.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'login_attempts'`,
      );
      const columns = result.rows.map((r: { column_name: string }) => r.column_name);
      expect(columns).toEqual(expect.arrayContaining(['id', 'identifier', 'created_at']));
      // The throttle key is the submitted email; the table carries no password,
      // token, hash, or direct user/tenant identity to leak or cascade.
      for (const forbidden of ['password', 'password_hash', 'token', 'token_hash', 'user_id', 'tenant_id']) {
        expect(columns).not.toContain(forbidden);
      }
    });
  });
});
