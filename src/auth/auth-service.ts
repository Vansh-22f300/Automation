/**
 * The human-authentication use-case layer: login, logout, and "who am I".
 *
 * This is the framework-free heart of Phase 3. It knows nothing about Fastify,
 * HTTP, or cookies — it takes plain inputs and returns discriminated results the
 * route layer maps to status codes. Keeping the security decisions here (not in
 * handlers) means they can be unit-tested against fakes with no server and no
 * database, and there is exactly one place where "is this login allowed" lives.
 *
 * Security invariants it upholds:
 *   - **One generic failure.** Unknown email, wrong password, missing credential,
 *     disabled user, and no eligible tenant all return the same
 *     `invalid_credentials` result. None of them reveals which it was.
 *   - **Uniform cost.** Exactly one Argon2id verify runs on every login attempt —
 *     against the real hash when there is one, or a fixed valid dummy hash when
 *     there is not — so an unknown email cannot be told from a known one by timing
 *     (mirrors the api-key authenticator's dummy-hash discipline).
 *   - **The tenant is never the caller's to pick.** It is resolved from the
 *     user's active memberships. Exactly one → a session is minted; zero → generic
 *     failure; more than one → `tenant_selection_required`, with no session and no
 *     tenant identities disclosed.
 *   - **The token is a one-time value.** Only its SHA-256 hash is stored; the
 *     plaintext is returned once and never logged or persisted.
 *   - **Throttle before verify, record after failure, clear on success**, keyed by
 *     the submitted email (see `@/auth/login-throttle`).
 */

import type { PasswordHasher } from '@/auth/password.js';
import { generateSessionToken, hashSessionToken } from '@/auth/session-token.js';
import type { SessionStore } from '@/auth/session-store.js';
import type { AuthProfile, AuthUserStore } from '@/auth/auth-user-store.js';
import type { LoginThrottle } from '@/auth/login-throttle.js';

/**
 * A fixed, valid Argon2id hash (same cost params as `@/auth/password`) verified
 * against when no credential exists, so the KDF cost of a login is identical
 * whether or not the email is real. Its plaintext is a throwaway constant that is
 * never a user's password; the explicit `passwordHash === null` guard means even
 * a freak match here could not authenticate. Precomputed, so it adds no runtime
 * or import-time hashing cost.
 */
const DUMMY_PASSWORD_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$Bfocdu0HiHgsUJqlaKBXJA$9aPlB6h1D4bk7Z389v95+wnHbvU9xpODtTCB+taSP0c';

/**
 * Absolute session lifetime: 24 hours from issue. A fixed policy, not a
 * configurable surface — a login service should not be able to dial session
 * security down by accident, the same stance `@/auth/password` takes on KDF cost.
 * There is no sliding renewal yet; expiry is enforced in SQL by the session store.
 */
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/** The safe, public identity returned to a signed-in caller. */
export interface AuthenticatedIdentity {
  readonly user: { readonly id: string; readonly email: string; readonly name: string | null };
  readonly tenant: { readonly id: string; readonly name: string };
}

/** The result of a login attempt — a closed set the route maps to HTTP. */
export type LoginResult =
  | ({
      readonly kind: 'authenticated';
      readonly token: string;
      readonly expiresAt: Date;
    } & AuthenticatedIdentity)
  | { readonly kind: 'invalid_credentials' }
  | { readonly kind: 'tenant_selection_required' }
  | { readonly kind: 'rate_limited' };

/** Normalise an email to the form stored/compared: trimmed and lower-cased. */
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export class AuthService {
  constructor(
    private readonly users: AuthUserStore,
    private readonly passwordHasher: PasswordHasher,
    private readonly sessions: SessionStore,
    private readonly throttle: LoginThrottle,
  ) {}

  async login(email: string, password: string): Promise<LoginResult> {
    const identifier = normalizeEmail(email);

    // Gate first, so a correct password can never bypass the throttle and the
    // KDF is not spent on an already-throttled account.
    if (await this.throttle.isThrottled(identifier)) {
      return { kind: 'rate_limited' };
    }

    const account = await this.users.findLoginByEmail(identifier);

    // Always exactly one verify: real hash when present, dummy otherwise. The
    // await happens unconditionally, so timing does not branch on existence.
    const storedHash = account?.passwordHash ?? DUMMY_PASSWORD_HASH;
    const passwordOk = await this.passwordHasher.verify(storedHash, password);

    // Every credential failure collapses here into one indistinguishable outcome.
    if (
      account === null ||
      account.userStatus !== 'active' ||
      account.passwordHash === null ||
      !passwordOk
    ) {
      await this.throttle.recordFailure(identifier);
      return { kind: 'invalid_credentials' };
    }

    const eligible = account.activeMemberships;

    if (eligible.length === 0) {
      // Valid password but no tenant to act in: still a generic failure so it is
      // indistinguishable from a wrong password, and recorded like any other.
      await this.throttle.recordFailure(identifier);
      return { kind: 'invalid_credentials' };
    }

    if (eligible.length > 1) {
      // Legitimate multi-tenant account. The credentials were correct, so this is
      // not a failed attempt (not recorded); but no session is minted and no
      // tenant is chosen for the caller — selection is a later, explicit design.
      return { kind: 'tenant_selection_required' };
    }

    const membership = eligible[0]!;
    const token = generateSessionToken();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await this.sessions.create({
      tenantId: membership.tenantId,
      userId: account.userId,
      tokenHash: hashSessionToken(token),
      expiresAt,
    });

    await this.throttle.clear(identifier);

    return {
      kind: 'authenticated',
      token,
      expiresAt,
      user: { id: account.userId, email: account.email, name: account.name },
      tenant: { id: membership.tenantId, name: membership.tenantName },
    };
  }

  /**
   * Revoke the session behind a presented token. Idempotent: revoking an unknown,
   * expired, or already-revoked token is a silent no-op, so a repeated logout is
   * safe. The caller passes the token it authenticated with — never an id — so it
   * can only ever end its own session.
   */
  async logout(token: string): Promise<void> {
    await this.sessions.revoke(hashSessionToken(token));
  }

  /**
   * Resolve the safe public identity for an already-authenticated session. The
   * (userId, tenantId) pair comes from the verified session context, not request
   * input. Returns null if the identity has since vanished, which the route turns
   * into the same unauthorized response as any other — never a distinct signal.
   */
  async getCurrentSession(userId: string, tenantId: string): Promise<AuthProfile | null> {
    return this.users.findProfile(userId, tenantId);
  }
}
