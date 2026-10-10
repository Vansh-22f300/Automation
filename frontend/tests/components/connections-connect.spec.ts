/**
 * Component tests for the Connect-GitHub flow on `pages/connections.vue`.
 *
 * Mounted in happy-dom with the Nuxt auto-imports the page needs stubbed locally
 * (a fake API client, OAuth client, and a faithful `useResource`). They cover the
 * UI contract: the button is present and starts exactly one initiation, a
 * non-GitHub authorization URL is refused before any navigation, a BFF error
 * surfaces a friendly message, returning from the callback reflects REFRESHED
 * metadata (never an assumed success), and the existing Slack display is intact.
 */
import { config, flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick, onMounted, ref } from "vue";
import Connections from "../../pages/connections.vue";
import { ApiClientError } from "../../lib/api-client";
import "./helpers/nuxt-stubs";

interface Conn {
  id: string; provider: string; name: string; status: string;
  metadata: Record<string, unknown>; createdAt: string; updatedAt: string; lastUsedAt: string | null;
}

const ISO = "2026-01-01T00:00:00.000Z";
function conn(partial: Partial<Conn> & { provider: string; name: string }): Conn {
  return { id: `c-${partial.provider}-0000000000`, status: "active", metadata: {}, createdAt: ISO, updatedAt: ISO, lastUsedAt: ISO, ...partial };
}
function listResponse(items: Conn[]) {
  return { items, page: { limit: 20, nextCursor: null } };
}

let listConnections: ReturnType<typeof vi.fn>;
let beginGithubAuthorization: ReturnType<typeof vi.fn>;
let routeQuery: Record<string, unknown>;
let routerReplace: ReturnType<typeof vi.fn>;
let assign: ReturnType<typeof vi.fn>;

beforeEach(() => {
  listConnections = vi.fn(async () => listResponse([]));
  beginGithubAuthorization = vi.fn(async () => ({ authorizationUrl: "https://github.com/login/oauth/authorize?client_id=x" }));
  routeQuery = {};
  routerReplace = vi.fn();
  assign = vi.spyOn(window.location, "assign").mockImplementation(() => undefined) as unknown as ReturnType<typeof vi.fn>;

  vi.stubGlobal("useApiClient", () => ({ listConnections: (...a: unknown[]) => listConnections(...a) }));
  vi.stubGlobal("useOAuthClient", () => ({ beginGithubAuthorization: () => beginGithubAuthorization() }));
  vi.stubGlobal("useResource", <T,>(loader: () => Promise<T>, immediate = true) => {
    const data = ref<T>();
    const error = ref<string>();
    const pending = ref(immediate);
    async function refresh(): Promise<void> {
      pending.value = true;
      error.value = undefined;
      try { data.value = await loader(); }
      catch (e) { error.value = e instanceof Error ? e.message : "err"; }
      finally { pending.value = false; }
    }
    if (immediate) onMounted(() => void refresh());
    return { data, error, pending, refresh };
  });
  vi.stubGlobal("useRoute", () => ({ path: "/connections", fullPath: "/connections", query: routeQuery }));
  vi.stubGlobal("useRouter", () => ({ replace: routerReplace, push: vi.fn() }));

  config.global.stubs = {
    ...(config.global.stubs as Record<string, unknown>),
    PageHeader: true, StatusBadge: true, EmptyState: true, LoadingState: true, ErrorState: true,
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function mountReady() {
  const wrapper = mount(Connections);
  await flushPromises();
  await nextTick();
  return wrapper;
}

describe("Connect GitHub button", () => {
  it("renders the button and starts exactly one initiation, navigating to GitHub", async () => {
    const wrapper = await mountReady();
    const button = wrapper.get('[data-test="connect-github"]');
    expect(button.text()).toContain("Connect GitHub");
    await button.trigger("click");
    await flushPromises();
    expect(beginGithubAuthorization).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith("https://github.com/login/oauth/authorize?client_id=x");
  });

  it("ignores duplicate clicks while an initiation is pending", async () => {
    beginGithubAuthorization = vi.fn(() => new Promise<{ authorizationUrl: string }>(() => undefined));
    const wrapper = await mountReady();
    const button = wrapper.get('[data-test="connect-github"]');
    await button.trigger("click");
    await button.trigger("click");
    await flushPromises();
    expect(beginGithubAuthorization).toHaveBeenCalledTimes(1);
    expect(assign).not.toHaveBeenCalled();
  });
});

describe("Connect GitHub failures", () => {
  it("refuses a non-GitHub authorization URL and does not navigate", async () => {
    beginGithubAuthorization = vi.fn(async () => ({ authorizationUrl: "https://evil.example/login/oauth/authorize" }));
    const wrapper = await mountReady();
    await wrapper.get('[data-test="connect-github"]').trigger("click");
    await flushPromises();
    expect(assign).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain("safely");
  });

  it("shows a friendly message when GitHub OAuth is not configured (404)", async () => {
    beginGithubAuthorization = vi.fn(async () => { throw new ApiClientError(404, "nope"); });
    const wrapper = await mountReady();
    await wrapper.get('[data-test="connect-github"]').trigger("click");
    await flushPromises();
    expect(assign).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain("not enabled");
  });
});

describe("Connections registry", () => {
  it("reflects refreshed metadata on callback return when GitHub is present", async () => {
    routeQuery = { connected: "github" };
    listConnections = vi.fn(async () => listResponse([conn({ provider: "github", name: "octocat" })]));
    const wrapper = await mountReady();
    expect(listConnections).toHaveBeenCalled();
    expect(routerReplace).toHaveBeenCalled();
    expect(wrapper.text()).toContain("GitHub connected");
    expect(wrapper.text()).toContain("octocat");
  });

  it("leaves the existing Slack connection display intact", async () => {
    listConnections = vi.fn(async () => listResponse([conn({ provider: "slack", name: "prod", metadata: { team: "T1" } })]));
    const wrapper = await mountReady();
    expect(wrapper.text()).toContain("prod");
    expect(wrapper.text().toLowerCase()).toContain("slack");
    expect(wrapper.find('[data-test="connect-github"]').exists()).toBe(true);
    expect(wrapper.text()).not.toContain("GitHub connected");
  });
});
