<script setup lang="ts">
import { AlertCircle, Cable, CircleCheck, Lock, RefreshCw, ShieldCheck, Sparkles, X, Zap } from "@lucide/vue";
import { computed, onMounted, ref, watch } from "vue";
import { ApiClientError } from "~/lib/api-client";
import { formatDate } from "~/lib/format";
import { isTrustedGithubAuthorizeUrl } from "~/lib/oauth-client";

const api = useApiClient();
const oauth = useOAuthClient();
const pageLimit = 20;
const route = useRoute();
const router = useRouter();
const cursor = ref<string | undefined>(typeof route.query.cursor === 'string' ? route.query.cursor : undefined);
const previousCursors = ref<Array<string | undefined>>([]);

const { data, error, pending, refresh } = useResource(() =>
  api.listConnections(pageLimit, cursor.value),
);

const items = computed(() => data.value?.items ?? []);
const hasPrevious = computed(() => previousCursors.value.length > 0);
const hasNext = computed(() => (data.value?.page.nextCursor ?? null) !== null);
const activeCount = computed(() => items.value.filter(c => c.status === 'active').length);

// GitHub status must NOT be inferred from the visible 20-item page alone — a
// connection on another page would read as "absent". A single bounded,
// tenant-scoped, metadata-only probe (the list API's max page size) is the
// authoritative source. It is TRI-STATE so an INCOMPLETE result is never reported
// as "not connected":
//   - 'connected' — an active GitHub connection was seen;
//   - 'absent'    — the probe saw EVERY connection (no next page) and none is GitHub;
//   - 'unknown'   — a next page exists (GitHub may be beyond the window) or the
//                   probe failed; we cannot conclude either way.
const GITHUB_STATUS_PROBE_LIMIT = 100;
type GithubProbeStatus = 'unknown' | 'connected' | 'absent';
const pageHasActiveGithub = computed(() =>
  items.value.some(c => c.provider === 'github' && c.status === 'active'),
);
const probedGithubStatus = ref<GithubProbeStatus>('unknown');
// Only a positive signal asserts "connected"; 'absent'/'unknown' never render a
// false "connected", and 'unknown' never renders a false "disconnected".
const hasActiveGithub = computed(
  () => pageHasActiveGithub.value || probedGithubStatus.value === 'connected',
);

async function probeGithubStatus(): Promise<void> {
  try {
    const probe = await api.listConnections(GITHUB_STATUS_PROBE_LIMIT);
    if (probe.items.some(c => c.provider === 'github' && c.status === 'active')) {
      probedGithubStatus.value = 'connected';
    } else if ((probe.page.nextCursor ?? null) === null) {
      // Saw every connection; none is an active GitHub → definitively absent.
      probedGithubStatus.value = 'absent';
    } else {
      // A next page exists: GitHub could be beyond this bounded window. Do NOT
      // conclude "absent" — represent the incomplete result as unknown.
      probedGithubStatus.value = 'unknown';
    }
  } catch {
    // Probe failed — remain 'unknown'; never report "not connected" from a failure.
    probedGithubStatus.value = 'unknown';
  }
}

// --- GitHub OAuth connect ---------------------------------------------------
// A click POSTs to the dedicated same-origin BFF route, which forwards the
// HttpOnly session (never a machine key) to Fastify and returns the provider
// authorization URL. We validate that URL is really https://github.com before a
// full-page navigation, and we never treat "the authorize page opened" as proof
// of success — the registry metadata below is the source of truth.
const connecting = ref(false);
const connectError = ref<string | undefined>();
const oauthReturn = ref<'idle' | 'connected' | 'unconfirmed'>('idle');
const confirmingGithub = ref(false);

async function connectGithub(): Promise<void> {
  if (connecting.value) return; // at most one pending initiation
  connecting.value = true;
  connectError.value = undefined;
  try {
    const { authorizationUrl } = await oauth.beginGithubAuthorization();
    if (!isTrustedGithubAuthorizeUrl(authorizationUrl)) {
      // Defence-in-depth: never navigate anywhere but https://github.com.
      connecting.value = false;
      connectError.value = "We couldn't start the GitHub connection safely. Please try again.";
      return;
    }
    // Full-page navigation to GitHub's consent screen. Leave `connecting` true —
    // we are leaving the page and resetting it would only flicker the button.
    window.location.assign(authorizationUrl);
  } catch (caught) {
    connecting.value = false;
    connectError.value = connectErrorMessage(caught);
  }
}

watch(cursor, (v) => {
  router.replace({ query: { ...route.query, cursor: v ?? undefined } });
});

async function loadNext(): Promise<void> {
  const next = data.value?.page.nextCursor;
  if (!next) return;
  previousCursors.value.push(cursor.value);
  cursor.value = next;
  await refresh();
}

async function loadPrevious(): Promise<void> {
  if (previousCursors.value.length === 0) return;
  cursor.value = previousCursors.value.pop();
  await refresh();
}

/** Map a BFF failure to a friendly, non-secret message. */
function connectErrorMessage(caught: unknown): string {
  if (caught instanceof ApiClientError) {
    switch (caught.status) {
      case 401:
        return 'Your session has expired. Please sign in again, then reconnect GitHub.';
      case 403:
        return 'That request was blocked by a security check. Reload the page and try again.';
      case 404:
        return 'GitHub connections are not enabled on this server yet. Ask an administrator to configure the GitHub OAuth app.';
      case 0:
      case 502:
      case 503:
      case 504:
        return 'We could not reach the server. Please try again in a moment.';
      default:
        return 'We could not start the GitHub connection. Please try again.';
    }
  }
  return 'We could not start the GitHub connection. Please try again.';
}

/**
 * Resolve the callback-return banner from the SETTLED, page-independent probe:
 * 'connected' only on a positive signal, otherwise 'unconfirmed' (a neutral,
 * retryable "can't confirm yet" — never a false "not connected"). Shared by the
 * initial mount and the Retry action.
 */
function resolveOauthReturn(): void {
  oauthReturn.value = hasActiveGithub.value ? 'connected' : 'unconfirmed';
}

async function retryGithubStatus(): Promise<void> {
  if (confirmingGithub.value) return;
  confirmingGithub.value = true;
  try {
    await Promise.all([refresh(), probeGithubStatus()]);
    resolveOauthReturn();
  } finally {
    confirmingGithub.value = false;
  }
}

// On every load, resolve GitHub status authoritatively (page-independent) so the
// connected indicator is correct even when viewing a later page. On a callback
// return (`?connected=github`), WAIT for the separate status probe to settle, strip
// the one-shot marker, then report from that refreshed status — never an assumed
// success, and never a false "missing" from pagination, an incomplete window, or a
// failed probe (those surface as a neutral, retryable "unable to confirm").
onMounted(async () => {
  await probeGithubStatus();
  if (route.query.connected !== 'github') return;
  const cleaned = { ...route.query };
  delete cleaned.connected;
  void router.replace({ query: cleaned });
  resolveOauthReturn();
});
</script>

<template>
  <div>
    <PageHeader
      title="Connected tools"
      eyebrow="Connections"
      description="Manage the services your workflows can use — provider connections, encrypted at rest, metadata only."
    />

    <div class="workspace-bento" style="margin-bottom:20px">
      <section class="panel" style="grid-column:span 4; padding:0; overflow:hidden; display:flex; flex-direction:column">
        <div style="padding:16px 20px; display:flex; align-items:center; justify-content:space-between; border-bottom:1px solid var(--landing-border)">
          <div style="display:flex; gap:10px; align-items:center">
            <span style="display:grid;place-items:center;width:28px;height:28px;border-radius:8px;background:rgba(183,164,251,0.12);border:1px solid rgba(183,164,251,0.22);color:var(--landing-lilac)"><Cable :size="14" aria-hidden="true" /></span>
            <div>
              <p style="margin:0;font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:var(--landing-faint);font-weight:600">Registry</p>
              <h2 style="margin:0;font-size:14px;color:var(--landing-mist)">{{ items.length }} connections</h2>
            </div>
          </div>
          <span class="pill" style="border-radius:999px; background:rgba(255,255,255,0.06)">{{ activeCount }} active</span>
        </div>
        <div style="padding:14px 20px; display:flex; gap:12px; flex-wrap:wrap; align-items:center; border-bottom:1px solid var(--landing-border); background:rgba(255,255,255,0.02)">
          <span style="display:inline-flex; gap:8px; align-items:center; font-size:12px; color:var(--landing-dim)"><span class="status-dot status-dot--success" aria-hidden="true" /> Active</span>
          <span style="display:inline-flex; gap:8px; align-items:center; font-size:12px; color:var(--landing-faint)"><Lock :size="12" aria-hidden="true" /> AES-256-GCM</span>
          <span style="display:inline-flex; gap:8px; align-items:center; font-size:12px; color:var(--landing-faint)"><ShieldCheck :size="12" aria-hidden="true" /> Never rendered</span>
        </div>
        <div style="padding:10px 20px; font-size:11px; color:var(--landing-faint); display:flex; gap:8px; align-items:center">
          <Zap :size="12" aria-hidden="true" style="color:var(--landing-lilac)" />
          <span>Tenant-scoped · provider, name, status and metadata counts only</span>
        </div>
      </section>

      <div style="grid-column:span 2; display:grid; gap:14px">
        <article class="metric-card card-sheen" style="min-height:96px; padding:16px 18px; display:flex; align-items:center; gap:12px; margin:0">
          <span style="display:grid;place-items:center;width:36px;height:36px;border-radius:10px;background:rgba(139,245,201,0.12);border:1px solid rgba(139,245,201,0.22);color:var(--landing-mint)"><Sparkles :size="16" aria-hidden="true" /></span>
          <div>
            <p style="margin:0;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;font-weight:600">Active</p>
            <strong style="font-size:22px;margin:2px 0 0;color:var(--landing-mint)">{{ activeCount }}</strong>
            <span style="font-size:11px">ready for workflows</span>
          </div>
        </article>
        <article class="panel card-sheen" style="padding:16px; display:flex; gap:12px; align-items:start; margin:0">
          <span style="display:grid;place-items:center;width:32px;height:32px;border-radius:10px;background:rgba(183,164,251,0.12);border:1px solid rgba(183,164,251,0.22);color:var(--landing-lilac); flex:0 0 auto"><ShieldCheck :size="16" aria-hidden="true" /></span>
          <div>
            <h3 style="margin:0;font-size:12px;color:var(--landing-mist)">Credentials protected</h3>
            <p style="margin:4px 0 0;font-size:11px;color:var(--landing-faint);line-height:1.6">Encrypted at rest, decrypted only for execution. UI never shows secrets.</p>
          </div>
        </article>
      </div>
    </div>

    <section class="panel" style="padding:0; overflow:hidden">
      <div style="padding:14px 20px; display:flex; align-items:center; justify-content:space-between; border-bottom:1px solid var(--landing-border)">
        <div>
          <h2 style="margin:0;font-size:14px;color:var(--landing-mist)">Connection registry</h2>
          <p style="margin:4px 0 0;font-size:11px;color:var(--landing-faint)">Large connection surfaces with provider identity and security indicators.</p>
        </div>
        <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap; justify-content:flex-end">
          <span
            v-if="hasActiveGithub"
            class="pill"
            style="border-radius:999px; display:inline-flex; gap:6px; align-items:center; color:var(--landing-mint); border-color:rgba(139,245,201,0.3); background:rgba(139,245,201,0.08)"
          >
            <CircleCheck :size="13" aria-hidden="true" /> GitHub connected
          </span>
          <button
            class="button button-primary"
            type="button"
            :disabled="connecting"
            :aria-busy="connecting"
            data-test="connect-github"
            style="border-radius:999px; display:inline-flex; gap:8px; align-items:center"
            @click="connectGithub"
          >
            <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" /></svg>
            {{ connecting ? 'Connecting…' : hasActiveGithub ? 'Reconnect GitHub' : 'Connect GitHub' }}
          </button>
          <button class="button button-secondary" type="button" @click="refresh" aria-label="Refresh connections" style="border-radius:999px">
            <RefreshCw :size="15" aria-hidden="true" />
            Refresh
          </button>
        </div>
      </div>

      <div style="padding:16px">
        <div v-if="oauthReturn === 'connected'" class="connect-banner connect-banner--ok" role="status">
          <CircleCheck :size="16" aria-hidden="true" style="color:var(--landing-mint); flex:0 0 auto; margin-top:1px" />
          <div class="connect-banner__copy">
            <strong>GitHub connected</strong>
            <span>Your workflows can now use this GitHub connection. It appears in the registry below.</span>
          </div>
          <button class="connect-banner__dismiss" type="button" aria-label="Dismiss" @click="oauthReturn = 'idle'"><X :size="15" aria-hidden="true" /></button>
        </div>
        <div v-else-if="oauthReturn === 'unconfirmed'" class="connect-banner connect-banner--info" role="status" data-test="oauth-unconfirmed">
          <AlertCircle :size="16" aria-hidden="true" style="color:var(--landing-lilac); flex:0 0 auto; margin-top:1px" />
          <div class="connect-banner__copy">
            <strong>Unable to confirm yet</strong>
            <span>We couldn’t confirm your GitHub connection — it may still be finishing. Retry in a moment.</span>
          </div>
          <button
            class="button button-secondary"
            type="button"
            data-test="retry-github-status"
            :disabled="confirmingGithub"
            :aria-busy="confirmingGithub"
            style="border-radius:999px; margin-left:auto; flex:0 0 auto"
            @click="retryGithubStatus"
          >
            {{ confirmingGithub ? 'Checking…' : 'Retry' }}
          </button>
          <button class="connect-banner__dismiss" type="button" aria-label="Dismiss" @click="oauthReturn = 'idle'"><X :size="15" aria-hidden="true" /></button>
        </div>
        <div v-if="connectError" class="connect-banner connect-banner--error" role="alert">
          <AlertCircle :size="16" aria-hidden="true" style="color:var(--landing-danger-strong); flex:0 0 auto; margin-top:1px" />
          <div class="connect-banner__copy">
            <strong>Couldn’t connect GitHub</strong>
            <span>{{ connectError }}</span>
          </div>
          <button class="connect-banner__dismiss" type="button" aria-label="Dismiss" @click="connectError = undefined"><X :size="15" aria-hidden="true" /></button>
        </div>

        <LoadingState v-if="pending" />
        <ErrorState v-else-if="error" :message="error" @retry="refresh" />
        <EmptyState
          v-else-if="items.length === 0"
          title="No connections yet"
          description="Connect a service to let your workflows use it. Use “Connect GitHub” above to link a GitHub account in one click. Other providers (like Slack) are added via the backend CLI. Either way, only encrypted metadata is shown here."
          hint="Other providers, e.g.: pnpm connections:create <tenantId> slack &quot;prod&quot; '{&quot;token&quot;:&quot;xoxb-...&quot;}'"
        />

        <template v-else>
          <div style="display:grid; grid-template-columns:repeat(auto-fill,minmax(320px,1fr)); gap:14px">
            <article v-for="connection in items" :key="connection.id" class="connection-card">
              <div style="display:flex; align-items:start; justify-content:space-between; gap:12px">
                <div style="display:flex; gap:10px; align-items:center; min-width:0">
                  <span style="display:grid;place-items:center;width:36px;height:36px;border-radius:10px;background:linear-gradient(135deg, rgba(139,245,201,0.14), rgba(183,164,251,0.14));border:1px solid var(--landing-border);color:var(--landing-mist);font-size:11px;font-weight:700;text-transform:uppercase;flex:0 0 auto">{{ connection.provider.slice(0,2) }}</span>
                  <div style="min-width:0">
                    <h3 style="margin:0;font-size:13px;color:var(--landing-mist);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">{{ connection.name }}</h3>
                    <p style="margin:2px 0 0;font-size:11px;color:var(--landing-faint);text-transform:capitalize">{{ connection.provider }} · {{ Object.keys(connection.metadata).length }} fields</p>
                  </div>
                </div>
                <span style="display:inline-flex; gap:6px; align-items:center; flex:0 0 auto">
                  <span class="status-dot" :class="connection.status==='active' ? 'status-dot--success' : ''" aria-hidden="true" />
                  <StatusBadge :status="connection.status" />
                </span>
              </div>
              <p class="mono-text" style="margin:10px 0 0; font-size:11px; color:var(--landing-faint); word-break:break-all" :title="connection.id">{{ connection.id.slice(0,8) }}…{{ connection.id.slice(-4) }}</p>
              <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:12px">
                <span class="pill" style="border-radius:999px; font-size:11px">{{ Object.keys(connection.metadata).length }} metadata fields</span>
                <span class="pill" style="border-radius:999px; font-size:11px">Last used {{ formatDate(connection.lastUsedAt) }}</span>
              </div>
              <div style="display:flex; align-items:center; gap:6px; margin-top:12px; padding-top:12px; border-top:1px solid var(--landing-border); font-size:11px; color:var(--landing-faint)">
                <Lock :size="12" aria-hidden="true" style="color:var(--landing-mint)" />
                <span>Updated {{ formatDate(connection.updatedAt) }}</span>
                <span style="margin-left:auto; display:inline-flex; gap:6px; align-items:center; color:var(--landing-mint)"><ShieldCheck :size="12" aria-hidden="true" /> secure</span>
              </div>
            </article>
          </div>
        </template>

        <div v-if="items.length > 0" style="display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; margin-top:16px; padding-top:14px; border-top:1px solid var(--landing-border)">
          <p style="margin:0; font-size:11px; color:var(--landing-faint)">Page size {{ pageLimit }} · cursor pagination</p>
          <div style="display:flex; gap:8px">
            <button class="button button-secondary" type="button" :disabled="!hasPrevious" @click="loadPrevious" style="border-radius:999px">Previous</button>
            <button class="button button-secondary" type="button" :disabled="!hasNext" @click="loadNext" style="border-radius:999px">Next</button>
          </div>
        </div>
      </div>
    </section>

    <section class="panel" style="margin-top:16px; display:flex; gap:16px; align-items:start; padding:18px">
      <span style="display:grid;place-items:center;width:40px;height:40px;border-radius:12px;background:rgba(183,164,251,0.12);border:1px solid rgba(183,164,251,0.22);color:var(--landing-lilac);flex:0 0 auto"><ShieldCheck :size="18" aria-hidden="true" /></span>
      <div>
        <h2 style="font-size:13px;margin:0 0 6px;color:var(--landing-mist)">Security — metadata only, encrypted at rest</h2>
        <p style="margin:0;color:var(--landing-dim);font-size:12px;line-height:1.6">Connection values are encrypted with AES-256-GCM and only decrypted for execution. The API `GET /v1/connections` never returns credentials, and this UI never renders them — only provider, name, status and non-secret metadata counts are shown. Create via <code style="font-family:var(--font-mono);font-size:11px;background:rgba(255,255,255,0.06);border:1px solid var(--landing-border);padding:1px 6px;border-radius:6px;color:var(--landing-mist)">pnpm connections:create</code> with a versioned envelope.</p>
      </div>
    </section>
  </div>
</template>

<style scoped>
.visually-hidden { position:absolute; left:-9999px; }
.connect-banner {
  display:flex; align-items:flex-start; gap:12px;
  margin:0 0 14px; padding:12px 14px; border-radius:12px;
  border:1px solid var(--landing-border); background:rgba(255,255,255,0.03);
  color:var(--landing-mist);
}
.connect-banner__copy { display:flex; flex-direction:column; gap:2px; min-width:0; font-size:12px; }
.connect-banner__copy strong { font-size:13px; letter-spacing:-0.01em; }
.connect-banner__copy span { color:var(--landing-dim); }
.connect-banner__dismiss {
  display:grid; place-items:center; width:28px; height:28px; border-radius:8px;
  border:1px solid transparent; background:transparent; color:var(--landing-faint);
  cursor:pointer; margin-left:auto; flex:0 0 auto;
}
.connect-banner__dismiss:hover { color:var(--landing-mist); background:rgba(255,255,255,0.06); }
.connect-banner--ok { border-color:rgba(139,245,201,0.28); background:rgba(139,245,201,0.08); }
.connect-banner--ok .connect-banner__copy span { color:var(--landing-mint); }
.connect-banner--info { border-color:rgba(183,164,251,0.26); background:rgba(183,164,251,0.08); }
.connect-banner--error { border-color:rgba(255,107,107,0.26); background:rgba(255,107,107,0.08); }
</style>
