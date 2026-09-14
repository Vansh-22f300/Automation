<script setup lang="ts">
import { Cable, RefreshCw, ShieldCheck, Lock, Sparkles } from "@lucide/vue";
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
      title="Connections"
      eyebrow="Integrations"
      description="Provider integrations for this tenant — credentials encrypted at rest, never rendered."
    />

    <section class="metric-grid" style="margin-bottom:20px">
      <article class="metric-card card-sheen" style="min-height:88px;padding:16px 20px;display:flex;align-items:center;gap:14px">
        <span style="display:grid;place-items:center;width:36px;height:36px;border-radius:10px;background:var(--brand-weak-bg);color:var(--brand-weak-text);border:1px solid var(--brand-weak-border)"><Cable :size="16" aria-hidden="true" /></span>
        <div>
          <p style="margin:0;color:var(--text-muted);font-size:11px;letter-spacing:0.08em;text-transform:uppercase;font-weight:600">Registry</p>
          <strong style="font-size:18px;margin:2px 0 0">{{ items.length }} connections</strong>
          <span>tenant-scoped</span>
        </div>
      </article>
      <article class="metric-card card-sheen" style="min-height:88px;padding:16px 20px;display:flex;align-items:center;gap:14px">
        <span style="display:grid;place-items:center;width:36px;height:36px;border-radius:10px;background:var(--success-bg);color:var(--success-text);border:1px solid rgba(23,114,69,0.18)"><Sparkles :size="16" aria-hidden="true" /></span>
        <div>
          <p style="margin:0;color:var(--text-muted);font-size:11px;letter-spacing:0.08em;text-transform:uppercase;font-weight:600">Active</p>
          <strong style="font-size:18px;margin:2px 0 0;color:var(--success-text)">{{ activeCount }}</strong>
          <span>ready for workflows</span>
        </div>
      </article>
      <article class="metric-card card-sheen" style="min-height:88px;padding:16px 20px;display:flex;align-items:center;gap:14px">
        <span style="display:grid;place-items:center;width:36px;height:36px;border-radius:10px;background:var(--neutral-bg);color:var(--neutral-text);border:1px solid var(--border)"><Lock :size="16" aria-hidden="true" /></span>
        <div>
          <p style="margin:0;color:var(--text-muted);font-size:11px;letter-spacing:0.08em;text-transform:uppercase;font-weight:600">Security</p>
          <strong style="font-size:18px;margin:2px 0 0">AES-256-GCM</strong>
          <span>never rendered</span>
        </div>
      </article>
    </section>

    <section class="panel panel--elevated table-shell">
      <div class="panel-heading">
        <div>
          <p class="eyebrow">Collection</p>
          <h2>Connection registry</h2>
          <p class="inline-note" style="margin-top:4px">Metadata only · AES-256-GCM envelope · tenant-scoped</p>
        </div>
        <button class="button button-secondary" type="button" @click="refresh" aria-label="Refresh connections" style="border-radius:999px">
          <RefreshCw :size="15" aria-hidden="true" />
          Refresh
        </button>
      </div>

      <LoadingState v-if="pending" />
      <ErrorState v-else-if="error" :message="error" @retry="refresh" />
      <EmptyState
        v-else-if="items.length === 0"
        title="No connections yet"
        description="Connections store encrypted provider credentials for workflows. Create one via backend CLI — then it appears here as metadata only."
        hint="Example: pnpm connections:create <tenantId> slack &quot;prod&quot; '{&quot;token&quot;:&quot;xoxb-...&quot;}'"
      />

      <template v-else>
        <div class="table-wrap">
          <table>
            <caption class="visually-hidden">Connections</caption>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Provider</th>
                <th scope="col">Status</th>
                <th scope="col">Metadata</th>
                <th scope="col">Last used</th>
                <th scope="col">Updated</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="connection in items" :key="connection.id">
                <td>
                  <div style="display:flex;align-items:center;gap:10px">
                    <span style="display:grid;place-items:center;width:28px;height:28px;border-radius:8px;background:var(--surface-sunken);border:1px solid var(--border-subtle);text-transform:uppercase;font-size:10px;font-weight:700;color:var(--text-secondary)">{{ connection.provider.slice(0,2) }}</span>
                    <div>
                      <strong>{{ connection.name }}</strong>
                      <p class="mono-text" style="margin:0" :title="connection.id">{{ connection.id.slice(0,8) }}…{{ connection.id.slice(-4) }}</p>
                    </div>
                  </div>
                </td>
                <td><span class="pill" style="text-transform:capitalize;border-radius:999px">{{ connection.provider }}</span></td>
                <td><span style="display:inline-flex;gap:8px;align-items:center"><span class="status-dot" :class="connection.status==='active' ? 'status-dot--success' : ''" aria-hidden="true" /><StatusBadge :status="connection.status" /></span></td>
                <td><span class="pill" style="border-radius:999px">{{ Object.keys(connection.metadata).length }} fields</span></td>
                <td style="white-space:nowrap">{{ formatDate(connection.lastUsedAt) }}</td>
                <td style="white-space:nowrap">{{ formatDate(connection.updatedAt) }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="card-list" role="list">
          <div v-for="connection in items" :key="connection.id" class="app-card" role="listitem">
            <div style="display:flex;justify-content:space-between;gap:8px;align-items:center">
              <div style="display:flex;gap:10px;align-items:center">
                <span style="display:grid;place-items:center;width:32px;height:32px;border-radius:10px;background:var(--surface-sunken);border:1px solid var(--border);font-size:10px;font-weight:700;text-transform:uppercase;color:var(--text-secondary)">{{ connection.provider.slice(0,2) }}</span>
                <strong>{{ connection.name }}</strong>
              </div>
              <span style="display:inline-flex;gap:6px;align-items:center"><span class="status-dot" :class="connection.status==='active' ? 'status-dot--success' : ''" aria-hidden="true" /><StatusBadge :status="connection.status" /></span>
            </div>
            <p style="margin:6px 0 0;color:var(--text-secondary);font-size:12px;text-transform:capitalize">{{ connection.provider }} · {{ Object.keys(connection.metadata).length }} metadata fields</p>
            <p class="mono-text" style="font-size:11px;word-break:break-all;margin-top:6px">{{ connection.id }}</p>
            <p style="margin:8px 0 0;color:var(--text-muted);font-size:12px">Last used: {{ formatDate(connection.lastUsedAt) }}</p>
          </div>
        </div>
      </template>

      <div v-if="items.length > 0" class="pagination-row" style="margin-top:12px;padding-top:14px;border-top:1px solid var(--border-subtle)">
        <p class="inline-note">Page size {{ pageLimit }} · cursor pagination</p>
        <div class="page-toolbar">
          <button class="button button-secondary" type="button" :disabled="!hasPrevious" @click="loadPrevious" style="border-radius:999px">Previous</button>
          <button class="button button-secondary" type="button" :disabled="!hasNext" @click="loadNext" style="border-radius:999px">Next</button>
        </div>
      </div>
    </section>

    <section class="panel panel--elevated" style="display:flex;gap:14px;align-items:start;background:var(--surface-raised);border-color:var(--brand-weak-border);border-radius:14px">
      <span style="display:grid;place-items:center;width:40px;height:40px;border-radius:12px;background:var(--brand-weak-bg);color:var(--brand-weak-text);border:1px solid var(--brand-weak-border);flex:0 0 auto"><ShieldCheck :size="18" aria-hidden="true" /></span>
      <div>
        <h2 style="font-size:14px;margin:0 0 4px">Credentials are never rendered</h2>
        <p style="margin:0;color:var(--text-secondary);font-size:13px;line-height:1.6">Connection values are encrypted at rest and only decrypted for execution. This UI shows only provider, name, status and non-secret metadata — by design. Create via <code style="font-family:var(--font-mono);font-size:11px;background:var(--surface-sunken);border:1px solid var(--border);padding:1px 6px;border-radius:6px">pnpm connections:create</code> and it appears here as metadata only.</p>
      </div>
    </section>
  </div>
</template>

<style scoped>
.visually-hidden { position:absolute; left:-9999px; }
tbody tr:hover { background: var(--surface-raised); }
</style>
