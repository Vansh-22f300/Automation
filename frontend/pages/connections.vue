<script setup lang="ts">
import { Cable, RefreshCw, ShieldCheck, Lock, Sparkles, Zap } from "@lucide/vue";
import { computed, ref, watch } from "vue";
import { formatDate } from "~/lib/format";

const api = useApiClient();
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
        <button class="button button-secondary" type="button" @click="refresh" aria-label="Refresh connections" style="border-radius:999px">
          <RefreshCw :size="15" aria-hidden="true" />
          Refresh
        </button>
      </div>

      <div style="padding:16px">
        <LoadingState v-if="pending" />
        <ErrorState v-else-if="error" :message="error" @retry="refresh" />
        <EmptyState
          v-else-if="items.length === 0"
          title="No connections yet"
          description="Connections store encrypted provider credentials for workflows. Create one via backend CLI — then it appears here as metadata only."
          hint="Example: pnpm connections:create <tenantId> slack &quot;prod&quot; '{&quot;token&quot;:&quot;xoxb-...&quot;}'"
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
</style>
