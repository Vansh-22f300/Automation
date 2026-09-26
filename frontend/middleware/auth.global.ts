/**
 * Global client-side route guard (SPA, `ssr: false`).
 *
 * The GET session probe is the single source of truth. Public routes render
 * without a session; every other route requires an authenticated one, and an
 * unauthenticated visitor is bounced to `/login` with the intended path
 * preserved. `/login` and `/` are always public, so there is no redirect loop.
 */
const PUBLIC_PATHS = new Set(["/", "/login"]);

export default defineNuxtRouteMiddleware(async (to) => {
  const { ensureLoaded } = useAuth();
  const status = await ensureLoaded();

  // A signed-in user has no business on the login page — send them inward.
  if (to.path === "/login" && status === "authenticated") {
    return navigateTo("/workflows");
  }

  if (PUBLIC_PATHS.has(to.path)) return;

  // Protected route without a live session (logged out or backend unavailable)
  // → login, remembering where they were headed.
  if (status !== "authenticated") {
    return navigateTo({ path: "/login", query: { redirect: to.fullPath } });
  }
});
