<script setup lang="ts">
import { Cable, RefreshCw, ShieldCheck } from "@lucide/vue";
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

    <section class="panel table-shell">
      <div class="panel-heading">
        <div>
          <p class="eyebrow">Collection</p>
          <h2>Connection registry</h2>
          <p class="inline-note" style="margin-top:4px">Metadata only · AES-256-GCM envelope · tenant-scoped</p>
        </div>
        <button class="button button-secondary" type="button" @click="refresh" aria-label="Refresh connections">
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
                  <strong>{{ connection.name }}</strong>
                  <p class="mono-text" :title="connection.id">{{ connection.id.slice(0,8) }}…{{ connection.id.slice(-4) }}</p>
                </td>
                <td><span class="pill" style="text-transform:capitalize">{{ connection.provider }}</span></td>
                <td><StatusBadge :status="connection.status" /></td>
                <td><span class="pill">{{ Object.keys(connection.metadata).length }} fields</span></td>
                <td>{{ formatDate(connection.lastUsedAt) }}</td>
                <td>{{ formatDate(connection.updatedAt) }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="card-list" role="list">
          <div v-for="connection in items" :key="connection.id" class="data-card" role="listitem">
            <div style="display:flex;justify-content:space-between;gap:8px;align-items:center">
              <strong>{{ connection.name }}</strong>
              <StatusBadge :status="connection.status" />
            </div>
            <p style="margin:4px 0 0;color:var(--text-secondary);font-size:12px;text-transform:capitalize">{{ connection.provider }} · {{ Object.keys(connection.metadata).length }} metadata fields</p>
            <p class="mono-text" style="font-size:11px;word-break:break-all;margin-top:6px">{{ connection.id }}</p>
            <p style="margin:8px 0 0;color:var(--text-muted);font-size:12px">Last used: {{ formatDate(connection.lastUsedAt) }}</p>
          </div>
        </div>
      </template>

      <div v-if="items.length > 0" class="pagination-row">
        <p class="inline-note">Page size {{ pageLimit }} · cursor pagination</p>
        <div class="page-toolbar">
          <button class="button button-secondary" type="button" :disabled="!hasPrevious" @click="loadPrevious">Previous</button>
          <button class="button button-secondary" type="button" :disabled="!hasNext" @click="loadNext">Next</button>
        </div>
      </div>
    </section>

    <section class="panel" style="display:flex;gap:12px;align-items:start;background:var(--surface-raised);border-color:var(--brand-weak-border)">
      <span style="display:grid;place-items:center;width:36px;height:36px;border-radius:10px;background:var(--brand-weak-bg);color:var(--brand-weak-text);flex:0 0 auto"><ShieldCheck :size="18" aria-hidden="true" /></span>
      <div>
        <h2 style="font-size:14px;margin:0 0 4px">Credentials are never rendered</h2>
        <p style="margin:0;color:var(--text-secondary);font-size:13px;line-height:1.6">Connection values are encrypted at rest and only decrypted for execution. This UI shows only provider, name, status and non-secret metadata — by design.</p>
      </div>
    </section>
  </div>
</template>

<style scoped>
.visually-hidden { position:absolute; left:-9999px; }
</style>
