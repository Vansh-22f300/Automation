/**
 * Integration tests for the SESSION-AUTHORIZED DATA PLANE.
 *
 * The milestone under test makes the human *session* — not the machine API key —
 * the authorization identity for browser tenant-data reads on `/v1/*`. These
 * require a real PostgreSQL and are SKIPPED (never faked) unless
 * `TEST_DATABASE_URL` is set.
 *
 * They drive the *assembled* app (`buildApp` + `app.inject`) with the real auth
 * stack (the production `CompositeAuthenticator` guarding `/v1/*`, the real
 * session store/authenticator, Argon2id, the login throttle) AND a real,
 * tenant-scoped `WorkflowRepository`. So what they prove is the backend security
 * boundary the BFF depends on:
 *
 *     session token → SessionAuthenticator → { userId, tenantId } → tenant-scoped repo
 *
 * The tenant is read from the session row alone. Nothing the caller supplies —
 * URL, body, `X-Tenant-Id`, `X-User-Id`, or a browser `Authorization` header —
 * can change it, and a session for tenant A can never read tenant B. A machine
 * API key still authenticates `/v1/*` unchanged.
 *
 * Coverage split (the milestone's required checks):
 *   - a browser `Authorization` cannot override the BFF-selected credential
 *     (req 6) is a BFF-layer property, proven in `frontend/.../bff.spec.ts`;
 *   - multi-membership login refusal (409, req 8) and the API-key / `/auth`
 *     split are proven in `src/test/integration/auth.test.ts`;
 *   - existing tenant-isolation guarantees (req 12) are proven by the wider suite.
 *
 * Cleanup mirrors `auth.test.ts`: this run's `@dataplane-it.test` emails and the
 * cascading tenant deletes remove every seeded row.
 */

import { and, eq, like } from 'drizzle-orm';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '@/api/app.js';
import { AuthService } from '@/auth/auth-service.js';
import { DrizzleAuthUserStore } from '@/auth/auth-user-store.js';
import { DrizzleLoginThrottle } from '@/auth/login-throttle.js';
import { argon2PasswordHasher } from '@/auth/password.js';
import { SessionAuthenticator } from '@/auth/session-authenticator.js';
import { DrizzleSessionStore } from '@/auth/session-store.js';
import { ApiKeyAuthenticator } from '@/auth/api-key-authenticator.js';
import { DrizzleApiKeyStore } from '@/auth/api-key-store.js';
import { CompositeAuthenticator } from '@/auth/composite-authenticator.js';
import type { ApiServer } from '@/api/types.js';
import type { DatabaseHandle } from '@/db/client.js';
import { loginAttempts, memberships, passwordCredentials, tenants, users, workflows } from '@/db/schema.js';
import { ApiKeyRepository } from '@/repositories/api-key-repository.js';
import { TenantScope } from '@/repositories/tenant-scope.js';
import { WorkflowRepository } from '@/repositories/workflow-repository.js';

import { TEST_DATABASE_URL, createTestDatabaseHandle } from './support.js';

const PASSWORD = 'correct-horse-battery-staple';
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const email = (who: string): string => `${who}-${RUN}@dataplane-it.test`;
const bearer = (token: string): { authorization: string } => ({ authorization: `Bearer ${token}` });

/** Non-auth, non-workflow surfaces buildApp requires but this suite never drives. */
const unusedFactories = {
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

describe.skipIf(TEST_DATABASE_URL === undefined)('session-authorized data plane', () => {
  let handle: DatabaseHandle;
  let app: ApiServer;
  let tenantAId: string;
  let tenantBId: string;
  let alphaId: string;
  let disabledCaseId: string;
  const userIds: string[] = [];
  const WF_A = `wf-a-${RUN}`;
  const WF_B = `wf-b-${RUN}`;

  const seedUser = async (who: string, tenantId: string, passwordHash: string): Promise<string> => {
    const [user] = await handle.db
      .insert(users)
      .values({ email: email(who), name: who, status: 'active' })
      .returning({ id: users.id });
    const userId = user!.id;
    userIds.push(userId);
    await handle.db.insert(passwordCredentials).values({ userId, passwordHash });
    await handle.db.insert(memberships).values({ tenantId, userId, role: 'member', status: 'active' });
    return userId;
  };

  beforeAll(async () => {
    handle = createTestDatabaseHandle();
    await handle.verifyConnection();

    const insertedTenants = await handle.db
      .insert(tenants)
      .values([{ name: 'Data Plane Tenant A' }, { name: 'Data Plane Tenant B' }])
      .returning({ id: tenants.id });
    tenantAId = insertedTenants[0]!.id;
    tenantBId = insertedTenants[1]!.id;

    const passwordHash = await argon2PasswordHasher.hash(PASSWORD);
    alphaId = await seedUser('alpha', tenantAId, passwordHash);
    await seedUser('beta', tenantBId, passwordHash);
    disabledCaseId = await seedUser('disabledcase', tenantAId, passwordHash);

    // One workflow per tenant, seeded as a bare row (no version → activeVersion
    // null). Enough to prove a session sees only its own tenant's rows.
    await handle.db.insert(workflows).values([
      { tenantId: tenantAId, name: WF_A },
      { tenantId: tenantBId, name: WF_B },
    ]);

    const sessionStore = new DrizzleSessionStore(handle.db);
    const sessionAuthenticator = new SessionAuthenticator(sessionStore);
    app = await buildApp({
      logger: pino({ level: 'silent' }),
      // The exact production guard for `/v1/*`: an `awk_` key routes to the
      // API-key authenticator, an opaque token to the session authenticator.
      authenticator: new CompositeAuthenticator(
        new ApiKeyAuthenticator(new DrizzleApiKeyStore(handle.db)),
        sessionAuthenticator,
      ),
      sessionAuthenticator,
      authService: new AuthService(
        new DrizzleAuthUserStore(handle.db),
        argon2PasswordHasher,
        sessionStore,
        new DrizzleLoginThrottle(handle.db),
      ),
      checkDatabase: async () => undefined,
      apiKeyServiceFor: (auth) => new ApiKeyRepository(new TenantScope(handle.db, auth.tenantId)),
      // The REAL tenant-scoped workflow repository — the tenant comes from the
      // resolved AuthContext, never from the request.
      workflowServiceFor: (auth) => new WorkflowRepository(new TenantScope(handle.db, auth.tenantId)),
      rateLimit: { max: 10_000 },
      ...unusedFactories,
    });
  });

  afterAll(async () => {
    if (handle === undefined) return;
    if (app !== undefined) await app.close();
    await handle.db.delete(loginAttempts).where(like(loginAttempts.identifier, `%${RUN}@dataplane-it.test`));
    // Deleting tenants cascades memberships → sessions and workflows; users cascade credentials.
    for (const id of [tenantAId, tenantBId]) {
      if (id !== undefined) await handle.db.delete(tenants).where(eq(tenants.id, id));
    }
    for (const id of userIds) {
      await handle.db.delete(users).where(eq(users.id, id));
    }
    await handle.close();
  });

  const login = (payload: unknown) =>
    app.inject({ method: 'POST', url: '/auth/login', payload: payload as never });

  const tokenFor = async (who: string): Promise<string> => {
    const res = await login({ email: email(who), password: PASSWORD });
    expect(res.statusCode).toBe(200);
    return res.json().session.token as string;
  };

  const workflowNames = (res: { json: () => unknown }): string[] =>
    (res.json() as { items: { name: string }[] }).items.map((i) => i.name);

  it('a valid session reads only its OWN tenant workflows, never another tenant', async () => {
    // alpha has exactly one active membership (tenant A), so login deterministically
    // binds tenant A — the server chooses it from the membership, not the caller.
    const token = await tokenFor('alpha');
    const res = await app.inject({ method: 'GET', url: '/v1/workflows', headers: bearer(token) });

    expect(res.statusCode).toBe(200);
    const names = workflowNames(res);
    expect(names).toContain(WF_A);
    expect(names).not.toContain(WF_B);
  });

  it('refuses /v1 data with no credential at all (no session cookie ⇒ no bearer)', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/workflows' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('unauthorized');
  });

  it('a machine API key still reads /v1 data unchanged, scoped to its own tenant', async () => {
    const key = await new ApiKeyRepository(new TenantScope(handle.db, tenantAId)).create('data-plane regression');
    const res = await app.inject({ method: 'GET', url: '/v1/workflows', headers: bearer(key.plaintext) });

    expect(res.statusCode).toBe(200);
    const names = workflowNames(res);
    expect(names).toContain(WF_A);
    expect(names).not.toContain(WF_B);
  });

  it('caller-supplied tenant/identity headers and query cannot override the session tenant', async () => {
    const token = await tokenFor('alpha');
    // The caller tries to point the request at tenant B every way it can. The route
    // reads the tenant only from the session AuthContext, so all of this is inert.
    const res = await app.inject({
      method: 'GET',
      url: `/v1/workflows?tenantId=${tenantBId}`,
      headers: { ...bearer(token), 'x-tenant-id': tenantBId, 'x-user-id': alphaId },
    });

    expect(res.statusCode).toBe(200);
    const names = workflowNames(res);
    expect(names).toContain(WF_A);
    expect(names).not.toContain(WF_B);
  });

  it('a revoked (logged-out) session immediately loses data access', async () => {
    const token = await tokenFor('alpha');
    const before = await app.inject({ method: 'GET', url: '/v1/workflows', headers: bearer(token) });
    expect(before.statusCode).toBe(200);

    const out = await app.inject({ method: 'POST', url: '/auth/logout', headers: bearer(token) });
    expect(out.statusCode).toBe(204);

    const after = await app.inject({ method: 'GET', url: '/v1/workflows', headers: bearer(token) });
    expect(after.statusCode).toBe(401);
    expect(after.json().error.code).toBe('unauthorized');
  });

  it('a disabled membership immediately loses data access, even with a live session token', async () => {
    // A dedicated member of tenant A, so disabling it cannot affect the other tests.
    const token = await tokenFor('disabledcase');
    const before = await app.inject({ method: 'GET', url: '/v1/workflows', headers: bearer(token) });
    expect(before.statusCode).toBe(200);

    // Disable the membership under the live session; the authenticator re-checks
    // membership status on every request, so the next call fails closed.
    await handle.db
      .update(memberships)
      .set({ status: 'disabled' })
      .where(and(eq(memberships.tenantId, tenantAId), eq(memberships.userId, disabledCaseId)));

    const after = await app.inject({ method: 'GET', url: '/v1/workflows', headers: bearer(token) });
    expect(after.statusCode).toBe(401);
    expect(after.json().error.code).toBe('unauthorized');
  });
});
