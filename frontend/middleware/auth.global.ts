/**
 * Global client-side route guard (SPA, `ssr: false`).
 *
 * The GET session probe is the single source of truth. Public routes render
 * without a session; every other route requires an authenticated one, and an
 * unauthenticated visitor is bounced to `/login` with the intended path
 * preserved. `/`, `/login`, and `/signup` are always public, so there is no
 * redirect loop. The email-recovery pages (`/verify-email`, `/forgot-password`,
 * `/reset-password`) are public too: their links are opened straight from an
 * email, often while logged out, and the token itself — never a live session —
 * is the authority the backend checks.
 */
const PUBLIC_PATHS = new Set([
  "/",
  "/login",
  "/signup",
  "/verify-email",
  "/forgot-password",
  "/reset-password",
]);

export default defineNuxtRouteMiddleware(async (to) => {
  const { ensureLoaded } = useAuth();
  const status = await ensureLoaded();

  // A signed-in user has no business on the login or signup page — send them
  // inward instead of letting them re-authenticate or create a second account.
  if ((to.path === "/login" || to.path === "/signup") && status === "authenticated") {
    return navigateTo("/workflows");
  }

  if (PUBLIC_PATHS.has(to.path)) return;

  // Protected route without a live session (logged out or backend unavailable)
  // → login, remembering where they were headed.
  if (status !== "authenticated") {
    return navigateTo({ path: "/login", query: { redirect: to.fullPath } });
  }
});
