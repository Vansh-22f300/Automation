import { computed, readonly, ref } from "vue";
import { AuthClient } from "~/lib/auth-client";
import type { AuthTenant, AuthUser } from "~/types/api";

/**
 * `idle`            — not yet probed this page load
 * `loading`         — a session probe is in flight
 * `authenticated`   — a live session exists
 * `unauthenticated` — cleanly logged out (BFF returned 401)
 * `unavailable`     — the backend could not be reached / errored (transient)
 */
export type AuthStatus =
  | "idle"
  | "loading"
  | "authenticated"
  | "unauthenticated"
  | "unavailable";

// Module-scoped singletons: one shared reactive auth state for the whole SPA
// (route guard, sidebar, login page). This is IN-MEMORY ONLY — never written to
// localStorage/sessionStorage/IndexedDB/cookies — and holds only safe identity
// metadata. The opaque session token is never stored here; it lives solely in
// the HttpOnly cookie managed by the BFF.
const user = ref<AuthUser | null>(null);
const tenant = ref<AuthTenant | null>(null);
const status = ref<AuthStatus>("idle");
let inflight: Promise<AuthStatus> | null = null;

export function useAuth() {
  const config = useRuntimeConfig();
  const client = new AuthClient({ baseUrl: config.public.apiBase });

  /** Force a fresh session probe and update the shared state. */
  async function refresh(): Promise<AuthStatus> {
    status.value = "loading";
    try {
      const session = await client.getSession();
      if (session === null) {
        user.value = null;
        tenant.value = null;
        status.value = "unauthenticated";
      } else {
        user.value = session.user;
        tenant.value = session.tenant;
        status.value = "authenticated";
      }
    } catch {
      // Backend unreachable / 5xx — kept distinct from a clean logged-out 401
      // so the guard does not treat a transient outage as "not signed in".
      user.value = null;
      tenant.value = null;
      status.value = "unavailable";
    }
    return status.value;
  }

  /**
   * Probe once and cache: subsequent client-side navigations reuse a resolved
   * authenticated/unauthenticated result (no flash, no redundant round-trip).
   * An `unavailable` result is not cached, so navigation self-heals when the
   * backend returns. Concurrent callers share a single in-flight probe.
   */
  async function ensureLoaded(): Promise<AuthStatus> {
    if (status.value === "authenticated" || status.value === "unauthenticated") {
      return status.value;
    }
    if (inflight === null) {
      inflight = refresh().finally(() => {
        inflight = null;
      });
    }
    return inflight;
  }

  /**
   * Best-effort re-probe of the session used purely to refresh identity fields
   * (notably `emailVerifiedAt`) — after a resend, after verifying, or right
   * after login/signup, whose responses do not carry verification state. Unlike
   * `refresh`, it neither flips to a `loading` flash nor downgrades an
   * established session to `unavailable` on a transient error; a clean 401,
   * however, is still honoured as logged-out.
   */
  async function syncIdentity(): Promise<void> {
    try {
      const session = await client.getSession();
      if (session === null) {
        user.value = null;
        tenant.value = null;
        status.value = "unauthenticated";
      } else {
        user.value = session.user;
        tenant.value = session.tenant;
        status.value = "authenticated";
      }
    } catch {
      // Transient backend failure — keep whatever state we already hold.
    }
  }

  async function login(email: string, password: string): Promise<void> {
    const result = await client.login(email, password);
    user.value = result.user;
    tenant.value = result.tenant;
    status.value = "authenticated";
  }

  async function signup(
    name: string,
    email: string,
    password: string,
    workspaceName: string,
  ): Promise<void> {
    const result = await client.signup(name, email, password, workspaceName);
    user.value = result.user;
    tenant.value = result.tenant;
    status.value = "authenticated";
  }

  async function logout(): Promise<void> {
    await client.logout();
    user.value = null;
    tenant.value = null;
    status.value = "unauthenticated";
  }

  /**
   * Re-send the current user's verification email, then sync identity so any
   * change in verification state is reflected. Returns the safe confirmation
   * message; rejects (with the client's `ApiClientError`) on 401/429/etc so the
   * caller can render a generic, status-appropriate message.
   */
  async function resendVerification(): Promise<string> {
    const { message } = await client.resendVerification();
    await syncIdentity();
    return message;
  }

  /**
   * Request a password-reset email. The response is a fixed generic message for
   * every account state, so nothing here reveals whether the address exists.
   */
  async function forgotPassword(email: string): Promise<string> {
    const { message } = await client.forgotPassword(email);
    return message;
  }

  /**
   * Complete a password reset. The backend has revoked EVERY session for the
   * user and the BFF has cleared our cookies, so we drop to the logged-out state
   * locally too — the user must sign in afresh with the new password.
   */
  async function resetPassword(password: string): Promise<string> {
    const { message } = await client.resetPassword(password);
    user.value = null;
    tenant.value = null;
    status.value = "unauthenticated";
    return message;
  }

  return {
    user: readonly(user),
    tenant: readonly(tenant),
    status: readonly(status),
    isAuthenticated: computed(() => status.value === "authenticated"),
    // True ONLY when we positively know the address is unverified (a definitive
    // `null`). `undefined` (verification state not yet probed, e.g. immediately
    // after login) reads as "unknown" and does NOT trip the prompt, so a
    // verified user never sees a spurious "verify your email" flash.
    needsVerification: computed(
      () =>
        status.value === "authenticated" &&
        user.value !== null &&
        user.value.emailVerifiedAt === null,
    ),
    refresh,
    ensureLoaded,
    syncIdentity,
    login,
    signup,
    logout,
    resendVerification,
    forgotPassword,
    resetPassword,
  };
}
