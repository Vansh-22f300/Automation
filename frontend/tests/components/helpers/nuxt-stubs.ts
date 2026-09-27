import { config } from "@vue/test-utils";
import { computed, h, onMounted, onUnmounted, readonly, ref } from "vue";
import { vi } from "vitest";

/**
 * Shared setup for the in-process component tests. `@vitejs/plugin-vue` compiles
 * our SFCs without Nuxt's Vite pipeline, so none of Nuxt's auto-imports or the
 * `<NuxtLink>` component exist at runtime. We provide the handful the tested
 * pages/components actually use as globals + a stub, mirroring Nuxt's behaviour
 * closely enough for rendering and link-target assertions.
 */

// --- Auth state the tests drive. `useAuth()` reads these refs, so flipping
//     `setAuth(...)` before mount changes what the component sees on first paint
//     (matching the real app, where the route guard resolves auth pre-render). ---
const authState = {
  isAuthenticated: ref(false),
  user: ref<{ email: string } | null>(null),
  tenant: ref<{ name: string } | null>(null),
};

export function setAuth(
  authenticated: boolean,
  identity?: { user?: { email: string } | null; tenant?: { name: string } | null },
): void {
  authState.isAuthenticated.value = authenticated;
  authState.user.value = identity?.user ?? null;
  authState.tenant.value = identity?.tenant ?? null;
}

// --- Vue runtime helpers Nuxt normally auto-imports (index.vue relies on these
//     being global; login/signup import `ref` explicitly, which is harmless). ---
vi.stubGlobal("ref", ref);
vi.stubGlobal("computed", computed);
vi.stubGlobal("readonly", readonly);
vi.stubGlobal("onMounted", onMounted);
vi.stubGlobal("onUnmounted", onUnmounted);

// --- Nuxt composables / macros. `useAuth` is backed by the shared authState. ---
vi.stubGlobal("definePageMeta", () => {});
vi.stubGlobal("useRoute", () => ({ path: "/", fullPath: "/", query: {} }));
vi.stubGlobal("useRouter", () => ({ replace: vi.fn(), push: vi.fn() }));
vi.stubGlobal("navigateTo", vi.fn());
vi.stubGlobal("useRuntimeConfig", () => ({ public: { apiBase: "/backend" } }));
vi.stubGlobal("useAuth", () => ({
  isAuthenticated: authState.isAuthenticated,
  user: authState.user,
  tenant: authState.tenant,
  status: computed(() => (authState.isAuthenticated.value ? "authenticated" : "unauthenticated")),
  login: vi.fn(),
  signup: vi.fn(),
  logout: vi.fn(),
  refresh: vi.fn(),
  ensureLoaded: vi.fn(),
}));

// --- happy-dom has no IntersectionObserver; index.vue constructs one on mount. ---
vi.stubGlobal(
  "IntersectionObserver",
  class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  },
);

// --- <NuxtLink> → a plain anchor so tests can assert on href targets. ---
config.global.stubs = {
  ...(config.global.stubs as Record<string, unknown>),
  NuxtLink: {
    props: ["to"],
    setup(props: { to: string }, { slots }: { slots: { default?: () => unknown } }) {
      return () => h("a", { href: props.to }, slots.default ? slots.default() : []);
    },
  },
};
