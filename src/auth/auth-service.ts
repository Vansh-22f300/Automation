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

import type { AccountStore } from '@/auth/account-store.js';
import { EmailAlreadyRegisteredError } from '@/auth/account-store.js';
import type { PasswordHasher } from '@/auth/password.js';
import { generateSessionToken, hashSessionToken } from '@/auth/session-token.js';
import { generateAuthToken, hashAuthToken } from '@/auth/auth-token.js';
import { VERIFICATION_TTL_MS } from '@/auth/email/auth-email-notifier.js';
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

/** What a caller supplies to create a brand-new account and its first workspace. */
export interface SignupInput {
  readonly name: string;
  readonly email: string;
  readonly password: string;
  readonly workspaceName: string;
}

/**
 * The result of a signup attempt — a closed set the route maps to HTTP.
 *   - `created` mints the account and returns a live session, exactly like a
 *     successful login (`token` is echoed once, for the BFF to bank as a cookie).
 *   - `email_taken` is the *only* non-success case: the email is already
 *     registered. It carries no detail about the existing account, so the route
 *     can render a generic 409 that is not a clean enumeration oracle.
 */
export type SignupResult =
  | ({
      readonly kind: 'created';
      readonly token: string;
      readonly expiresAt: Date;
    } & AuthenticatedIdentity)
  | { readonly kind: 'email_taken' };

/** Normalise an email to the form stored/compared: trimmed and lower-cased. */
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * The one notifier capability signup needs: fire a verification email after the
 * account exists. Optional and fire-and-forget — a real notifier swallows its
 * own transport errors, so a failed send never fails signup. Structurally a
 * subset of the recovery notifier, so one `AuthEmailNotifier` satisfies both.
 */
export interface SignupNotifier {
  sendVerification(input: {
    readonly to: string;
    readonly name: string | null;
    readonly rawToken: string;
  }): Promise<void>;
}

export class AuthService {
  constructor(
    private readonly users: AuthUserStore,
    private readonly passwordHasher: PasswordHasher,
    private readonly sessions: SessionStore,
    private readonly throttle: LoginThrottle,
    private readonly accounts: AccountStore,
    private readonly signupNotifier?: SignupNotifier,
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
   * Self-serve signup: create a brand-new account and its first workspace, and
   * return a live session so the caller is authenticated immediately.
   *
   * The server owns every identity fact. The email is normalised here (never
   * trusted from the client); the workspace, the global user, the credential,
   * the `owner` membership, and the session are all created server-side. Nothing
   * the caller could put in the body — a user id, a tenant id, a role — has any
   * effect: the input type carries only `{ name, email, password, workspaceName }`
   * and the store hard-codes ownership.
   *
   * The Argon2id hash and the CSPRNG token are computed *before* the transaction
   * (the slow KDF must not hold a DB transaction open), then handed to the store,
   * which commits all five rows atomically or not at all. A duplicate email
   * surfaces as the single generic `email_taken` result — never a distinct,
   * detail-carrying error — so a duplicate signup is not a clean user-enumeration
   * oracle. The plaintext token is returned exactly once and never logged.
   */
  async signup(input: SignupInput): Promise<SignupResult> {
    const email = normalizeEmail(input.email);
    const name = input.name.trim();
    const workspaceName = input.workspaceName.trim();

    // Outside the transaction on purpose: the KDF is deliberately slow and the
    // token is pure CSPRNG, so neither should hold a connection or row locks.
    const passwordHash = await this.passwordHasher.hash(input.password);
    const token = generateSessionToken();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

    // The email-verification token is minted here too (CSPRNG, outside the tx)
    // and only its hash is handed to the store, so the account and its first
    // verification token are created atomically. The plaintext exists only to
    // build the emailed link below.
    const verificationToken = generateAuthToken();
    const verificationExpiresAt = new Date(Date.now() + VERIFICATION_TTL_MS);

    try {
      const created = await this.accounts.createOwnerAccount({
        email,
        name: name.length > 0 ? name : null,
        passwordHash,
        workspaceName,
        tokenHash: hashSessionToken(token),
        expiresAt,
        verificationTokenHash: hashAuthToken(verificationToken),
        verificationExpiresAt,
      });

      // Best-effort: the account has already committed, so a mail-transport
      // failure must not fail signup. The notifier swallows its own errors; the
      // raw token leaves only inside the link it builds, never logged or returned.
      await this.signupNotifier?.sendVerification({
        to: created.user.email,
        name: created.user.name,
        rawToken: verificationToken,
      });

      return {
        kind: 'created',
        token,
        expiresAt,
        user: created.user,
        tenant: created.tenant,
      };
    } catch (error) {
      // The one expected, benign failure: the email is already registered.
      // Collapse it to a detail-free result; anything else is a real fault.
      if (error instanceof EmailAlreadyRegisteredError) {
        return { kind: 'email_taken' };
      }
      throw error;
    }
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
