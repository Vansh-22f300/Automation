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
function listResponse(items: Conn[], nextCursor: string | null = null) {
  return { items, page: { limit: 20, nextCursor } };
}

// A fully-formed GitHub authorize URL that passes the tightened trusted-URL guard.
const VALID_AUTHORIZE_URL =
  "https://github.com/login/oauth/authorize?response_type=code&client_id=Iv1.abc&redirect_uri=https%3A%2F%2Fapp.example%2Foauth%2Fgithub%2Fcallback&state=state123&code_challenge=chal123&code_challenge_method=S256&scope=read%3Auser";

let listConnections: ReturnType<typeof vi.fn>;
let beginGithubAuthorization: ReturnType<typeof vi.fn>;
let routeQuery: Record<string, unknown>;
let routerReplace: ReturnType<typeof vi.fn>;
let assign: ReturnType<typeof vi.fn>;

beforeEach(() => {
  listConnections = vi.fn(async () => listResponse([]));
  beginGithubAuthorization = vi.fn(async () => ({ authorizationUrl: VALID_AUTHORIZE_URL }));
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
    expect(assign).toHaveBeenCalledWith(VALID_AUTHORIZE_URL);
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

  it("detects a GitHub connection on a later page via the bounded status probe", async () => {
    // Visible page (limit 20) shows no GitHub; the authoritative probe (limit 100) finds it.
    listConnections = vi.fn(async (limit?: number) =>
      limit === 100
        ? listResponse([conn({ provider: "github", name: "octocat" })])
        : listResponse([conn({ provider: "slack", name: "prod" })], "next-cursor"),
    );
    const wrapper = await mountReady();
    expect(listConnections).toHaveBeenCalledWith(100); // the authoritative probe call shape
    expect(wrapper.text()).toContain("GitHub connected"); // from the probe, not the visible page
    expect(wrapper.text()).toContain("prod"); // the visible page still shows Slack
    expect(wrapper.find('[data-test="connect-github"]').exists()).toBe(true);
  });

  it("does not falsely report a missing GitHub connection on callback return with a cursor", async () => {
    routeQuery = { connected: "github", cursor: "page2" };
    listConnections = vi.fn(async (limit?: number) =>
      limit === 100
        ? listResponse([conn({ provider: "github", name: "octocat" })])
        : listResponse([conn({ provider: "slack", name: "prod" })], "next-cursor"),
    );
    const wrapper = await mountReady();
    expect(listConnections).toHaveBeenCalledWith(100); // probe ran despite the pagination cursor
    expect(routerReplace).toHaveBeenCalled(); // one-shot ?connected marker stripped
    expect(wrapper.find(".connect-banner--ok").exists()).toBe(true); // confirmed connected
    expect(wrapper.text()).toContain("GitHub connected");
    expect(wrapper.find('[data-test="oauth-unconfirmed"]').exists()).toBe(false); // not a false "can't confirm"
    expect(wrapper.text()).not.toContain("Unable to confirm");
  });

  it("reports a neutral 'unable to confirm' (never missing) when the probe window is incomplete on callback return", async () => {
    routeQuery = { connected: "github" };
    listConnections = vi.fn(async (limit?: number) =>
      limit === 100
        ? listResponse([conn({ provider: "slack", name: "prod" })], "more-cursor")
        : listResponse([conn({ provider: "slack", name: "prod" })], "next-cursor"),
    );
    const wrapper = await mountReady();
    expect(wrapper.find('[data-test="oauth-unconfirmed"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="retry-github-status"]').exists()).toBe(true);
    expect(wrapper.find(".connect-banner--ok").exists()).toBe(false);
    expect(wrapper.text()).toContain("Unable to confirm");
    expect(wrapper.text()).not.toContain("GitHub connected");
  });

  it("reports 'unable to confirm' on probe failure and recovers via Retry", async () => {
    routeQuery = { connected: "github" };
    let probeCalls = 0;
    listConnections = vi.fn(async (limit?: number) => {
      if (limit === 100) {
        probeCalls += 1;
        if (probeCalls === 1) throw new ApiClientError(0, "network down");
        return listResponse([conn({ provider: "github", name: "octocat" })]);
      }
      return listResponse([conn({ provider: "slack", name: "prod" })], "next-cursor");
    });
    const wrapper = await mountReady();
    expect(wrapper.find('[data-test="oauth-unconfirmed"]').exists()).toBe(true);
    await wrapper.get('[data-test="retry-github-status"]').trigger("click");
    await flushPromises();
    await nextTick();
    expect(wrapper.find('[data-test="oauth-unconfirmed"]').exists()).toBe(false);
    expect(wrapper.find(".connect-banner--ok").exists()).toBe(true);
    expect(wrapper.text()).toContain("GitHub connected");
  });

  it("waits for the GitHub-status probe to settle before confirming the callback return", async () => {
    routeQuery = { connected: "github" };
    let resolveProbe!: (v: ReturnType<typeof listResponse>) => void;
    const probePromise = new Promise<ReturnType<typeof listResponse>>((r) => {
      resolveProbe = r;
    });
    listConnections = vi.fn(async (limit?: number) => {
      if (limit === 100) return probePromise;
      return listResponse([conn({ provider: "slack", name: "prod" })], "next-cursor");
    });
    const wrapper = mount(Connections);
    await flushPromises(); // the visible list settles; the probe is still pending
    await nextTick();
    expect(wrapper.find(".connect-banner--ok").exists()).toBe(false);
    expect(wrapper.find('[data-test="oauth-unconfirmed"]').exists()).toBe(false);
    resolveProbe(listResponse([conn({ provider: "github", name: "octocat" })]));
    await flushPromises();
    await nextTick();
    expect(wrapper.find(".connect-banner--ok").exists()).toBe(true);
    expect(wrapper.text()).toContain("GitHub connected");
  });
});
