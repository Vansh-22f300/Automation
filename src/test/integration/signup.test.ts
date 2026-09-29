/**
 * Integration tests for SELF-SERVE SIGNUP (Phase 5) — require a real PostgreSQL
 * and are SKIPPED (never faked) unless `TEST_DATABASE_URL` is set.
 *
 * These drive the assembled app (`buildApp` + `app.inject`) with the real auth
 * stack wired to Postgres — the real `DrizzleAccountStore` (the transactional
 * account creator), Argon2id, the real session store/authenticator, and the
 * production composite guard on `/v1/*` — plus a real tenant-scoped
 * `WorkflowRepository`. So what they prove is the whole signup boundary:
 *
 *     POST /auth/signup → new tenant + global user + owner membership +
 *     password credential + session, all in ONE transaction → a live session
 *     that immediately authenticates as its OWN, server-chosen tenant.
 *
 * The server owns every identity fact: the caller supplies only
 * `{ name, email, password, workspaceName }`, and nothing it smuggles into the
 * body (a userId, tenantId, or role) can change who owns what. A duplicate email
 * is a single generic 409 that leaves nothing behind — proving atomicity.
 *
 * Cleanup: every created email shares `@signup-it.test` and every tenant name
 * ends with this run's token, so the suffixed deletes remove exactly this run's
 * rows (tenants cascade memberships → sessions and workflows; users cascade
 * credentials).
 */

import { and, eq, like } from 'drizzle-orm';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '@/api/app.js';
import { AuthService } from '@/auth/auth-service.js';
import { DrizzleAccountStore } from '@/auth/account-store.js';
import { DrizzleAuthUserStore } from '@/auth/auth-user-store.js';
import { DrizzleLoginThrottle } from '@/auth/login-throttle.js';
import { argon2PasswordHasher } from '@/auth/password.js';
import { SessionAuthenticator } from '@/auth/session-authenticator.js';
import { DrizzleSessionStore } from '@/auth/session-store.js';
import { hashSessionToken } from '@/auth/session-token.js';
import { ApiKeyAuthenticator } from '@/auth/api-key-authenticator.js';
import { DrizzleApiKeyStore } from '@/auth/api-key-store.js';
import { CompositeAuthenticator } from '@/auth/composite-authenticator.js';
import type { ApiServer } from '@/api/types.js';
import type { DatabaseHandle } from '@/db/client.js';
import { loginAttempts, memberships, passwordCredentials, sessions, tenants, users, workflows } from '@/db/schema.js';
import { ApiKeyRepository } from '@/repositories/api-key-repository.js';
import { TenantScope } from '@/repositories/tenant-scope.js';
import { WorkflowRepository } from '@/repositories/workflow-repository.js';

import { TEST_DATABASE_URL, createTestDatabaseHandle, inertAccountRecovery, inertOAuthService } from './support.js';
const PASSWORD = 'correct-horse-battery-staple';
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const email = (who: string): string => `${who}-${RUN}@signup-it.test`;
const workspace = (label: string): string => `${label} ${RUN}`;
const bearer = (token: string): { authorization: string } => ({ authorization: `Bearer ${token}` });

/** Non-auth, non-workflow surfaces buildApp requires but this suite never drives. */
const unusedFactories = {
  oauthService: inertOAuthService(),
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
describe.skipIf(TEST_DATABASE_URL === undefined)('signup API integration', () => {
  let handle: DatabaseHandle;
  let app: ApiServer;
  let otherTenantId: string;
  const OTHER_WF = `other-wf-${RUN}`;

  beforeAll(async () => {
    handle = createTestDatabaseHandle();
    await handle.verifyConnection();

    // A pre-existing, unrelated tenant with one workflow — the yardstick for
    // tenant isolation: a fresh signup session must never see this row.
    const [other] = await handle.db
      .insert(tenants)
      .values({ name: workspace('Signup Other Tenant') })
      .returning({ id: tenants.id });
    otherTenantId = other!.id;
    await handle.db.insert(workflows).values({ tenantId: otherTenantId, name: OTHER_WF });

    const sessionStore = new DrizzleSessionStore(handle.db);
    const sessionAuthenticator = new SessionAuthenticator(sessionStore);
    app = await buildApp({
      logger: pino({ level: 'silent' }),
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
        new DrizzleAccountStore(handle.db),
      ),
      checkDatabase: async () => undefined,
      accountRecoveryService: inertAccountRecovery(),
      apiKeyServiceFor: (auth) => new ApiKeyRepository(new TenantScope(handle.db, auth.tenantId)),
      workflowServiceFor: (auth) => new WorkflowRepository(new TenantScope(handle.db, auth.tenantId)),
      rateLimit: { max: 10_000 },
      ...unusedFactories,
    });
  });
  afterAll(async () => {
    if (handle === undefined) return;
    if (app !== undefined) await app.close();
    await handle.db.delete(loginAttempts).where(like(loginAttempts.identifier, `%${RUN}@signup-it.test`));
    // Tenants created by signup (and the seeded other tenant) all end with RUN;
    // deleting them cascades memberships → sessions and workflows.
    await handle.db.delete(tenants).where(like(tenants.name, `%${RUN}`));
    // Global users created by signup cascade their password credentials.
    await handle.db.delete(users).where(like(users.email, `%${RUN}@signup-it.test`));
    await handle.close();
  });

  const signup = (payload: unknown) =>
    app.inject({ method: 'POST', url: '/auth/signup', payload: payload as never });

  const workflowNames = (res: { json: () => unknown }): string[] =>
    (res.json() as { items: { name: string }[] }).items.map((i) => i.name);

  it('creates a new account and returns the safe shape with a usable session token', async () => {
    const res = await signup({
      name: 'Ada Owner',
      email: email('newowner'),
      password: PASSWORD,
      workspaceName: workspace('Ada Workspace'),
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.user).toMatchObject({ email: email('newowner'), name: 'Ada Owner' });
    expect(body.tenant).toMatchObject({ name: workspace('Ada Workspace') });
    expect(typeof body.tenant.id).toBe('string');
    expect(typeof body.session.token).toBe('string');
    expect(typeof body.session.expiresAt).toBe('string');
    // No credential material leaks in the envelope.
    const raw = res.body;
    expect(raw).not.toContain('passwordHash');
    expect(raw).not.toContain('tokenHash');
    expect(raw).not.toContain('$argon2');
  });
  it('persists all five entities — global user, tenant, OWNER membership, credential, hashed session', async () => {
    const res = await signup({
      name: 'Grace Owner',
      email: email('entities'),
      password: PASSWORD,
      workspaceName: workspace('Grace Workspace'),
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    const userId = body.user.id as string;
    const tenantId = body.tenant.id as string;
    const token = body.session.token as string;

    const [userRow] = await handle.db
      .select({ id: users.id, status: users.status })
      .from(users)
      .where(eq(users.id, userId));
    expect(userRow).toMatchObject({ id: userId, status: 'active' });

    const [tenantRow] = await handle.db.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, tenantId));
    expect(tenantRow).toBeDefined();

    const [membershipRow] = await handle.db
      .select({ role: memberships.role, status: memberships.status })
      .from(memberships)
      .where(and(eq(memberships.tenantId, tenantId), eq(memberships.userId, userId)));
    expect(membershipRow).toEqual({ role: 'owner', status: 'active' });

    const [credentialRow] = await handle.db
      .select({ userId: passwordCredentials.userId })
      .from(passwordCredentials)
      .where(eq(passwordCredentials.userId, userId));
    expect(credentialRow).toBeDefined();

    const [sessionRow] = await handle.db
      .select({ tokenHash: sessions.tokenHash })
      .from(sessions)
      .where(eq(sessions.tokenHash, hashSessionToken(token)));
    expect(sessionRow).toBeDefined();
    // The plaintext token is never at rest.
    expect(JSON.stringify(sessionRow)).not.toContain(token);
  });
  it('the returned session immediately authenticates on /auth/session and /v1, scoped to its own tenant', async () => {
    const res = await signup({
      name: 'Iso Owner',
      email: email('iso'),
      password: PASSWORD,
      workspaceName: workspace('Iso Workspace'),
    });
    expect(res.statusCode).toBe(201);
    const token = res.json().session.token as string;
    const tenantId = res.json().tenant.id as string;

    const session = await app.inject({ method: 'GET', url: '/auth/session', headers: bearer(token) });
    expect(session.statusCode).toBe(200);
    expect(session.json().tenant.id).toBe(tenantId);

    // A fresh workspace has no workflows and crucially cannot see the unrelated
    // tenant's workflow — session→tenant scoping and isolation both hold.
    const v1 = await app.inject({ method: 'GET', url: '/v1/workflows', headers: bearer(token) });
    expect(v1.statusCode).toBe(200);
    expect(workflowNames(v1)).not.toContain(OTHER_WF);
    expect(workflowNames(v1)).toHaveLength(0);
  });

  it('ignores caller-supplied userId, tenantId, and role — ownership is server-derived', async () => {
    const res = await signup({
      name: 'Mallory',
      email: email('mallory'),
      password: PASSWORD,
      workspaceName: workspace('Mallory Workspace'),
      // Attempts to hijack identity; Zod strips them and the store hard-codes
      // ownership, so none can take effect.
      userId: '00000000-0000-0000-0000-0000000000ff',
      tenantId: otherTenantId,
      role: 'owner',
      status: 'active',
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    // A brand-new tenant, never the tenant id the caller pointed at.
    expect(body.tenant.id).not.toBe(otherTenantId);
    expect(body.user.id).not.toBe('00000000-0000-0000-0000-0000000000ff');

    // The one membership is OWNER of the NEW tenant; the caller got no foothold in
    // the tenant it tried to name.
    const rows = await handle.db
      .select({ tenantId: memberships.tenantId, role: memberships.role })
      .from(memberships)
      .where(eq(memberships.userId, body.user.id as string));
    expect(rows).toEqual([{ tenantId: body.tenant.id, role: 'owner' }]);
  });
  it('rejects an already-registered email with a single generic 409 that leaks no detail', async () => {
    const dupe = email('dupe');
    const first = await signup({ name: 'First', email: dupe, password: PASSWORD, workspaceName: workspace('Dupe One') });
    expect(first.statusCode).toBe(201);

    const second = await signup({ name: 'Second', email: dupe, password: PASSWORD, workspaceName: workspace('Dupe Two') });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('email_unavailable');
    // Nothing about the existing account: no id, name, tenant, or workspace.
    expect(second.body).not.toContain('First');
    expect(second.body).not.toContain(first.json().user.id);
    expect(second.body).not.toContain(first.json().tenant.id);
  });

  it('leaves NOTHING behind when creation fails midway — the just-created tenant is rolled back', async () => {
    const clash = email('atomic');
    const first = await signup({ name: 'Owner', email: clash, password: PASSWORD, workspaceName: workspace('Atomic Keep') });
    expect(first.statusCode).toBe(201);

    // Same email, a DIFFERENT workspace name. The store inserts the tenant first,
    // then hits the unique-email violation on the user insert; the whole
    // transaction rolls back, so the orphaned workspace must not survive.
    const orphanName = workspace('Atomic Orphan');
    const second = await signup({ name: 'Owner', email: clash, password: PASSWORD, workspaceName: orphanName });
    expect(second.statusCode).toBe(409);

    const orphanTenants = await handle.db.select({ id: tenants.id }).from(tenants).where(eq(tenants.name, orphanName));
    expect(orphanTenants).toEqual([]);
  });

  it('rejects malformed or unsafe input with 400 before any account work', async () => {
    const base = { name: 'Val', email: email('valid'), password: PASSWORD, workspaceName: workspace('Val WS') };
    const cases = [
      { ...base, email: 'not-an-email' },
      { ...base, password: 'short' }, // < 8 chars
      { ...base, workspaceName: '   ' }, // trims to empty
      { ...base, name: '' }, // empty name
    ];
    for (const payload of cases) {
      const res = await signup(payload);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('bad_request');
    }
    // A rejected signup created no user.
    const leaked = await handle.db.select({ id: users.id }).from(users).where(eq(users.email, email('valid')));
    expect(leaked).toEqual([]);
  });

  it('leaves the machine API-key surface working unchanged, scoped to its own tenant', async () => {
    const key = await new ApiKeyRepository(new TenantScope(handle.db, otherTenantId)).create('signup-it regression');
    const res = await app.inject({ method: 'GET', url: '/v1/workflows', headers: bearer(key.plaintext) });
    expect(res.statusCode).toBe(200);
    // The API key sees ITS tenant's workflow — the auth path is untouched by signup.
    expect(workflowNames(res)).toContain(OTHER_WF);
  });
});
