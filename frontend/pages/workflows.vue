<script setup lang="ts">
import { ArrowRight, Layers, RefreshCw, Workflow, Sparkles } from "@lucide/vue";
import { computed, ref, watch } from "vue";
import { formatDate } from "~/lib/format";

const api = useApiClient();
const pageLimit = 20;
const route = useRoute();
const router = useRouter();
const cursor = ref<string | undefined>(typeof route.query.cursor === 'string' ? route.query.cursor : undefined);
const previousCursors = ref<Array<string | undefined>>([]);

const { data, error, pending, refresh } = useResource(() =>
  api.listWorkflows(pageLimit, cursor.value),
);

const items = computed(() => data.value?.items ?? []);
const hasPrevious = computed(() => previousCursors.value.length > 0);
const hasNext = computed(() => (data.value?.page.nextCursor ?? null) !== null);
const totalLabel = computed(() => items.value.length === 0 ? 'No workflows' : `${items.value.length} workflows`);
const activeCount = computed(() => items.value.filter(w => w.status === 'active').length);
const draftCount = computed(() => items.value.filter(w => w.status !== 'active').length);

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
      title="Workflows"
      eyebrow="Automation"
      description="Versioned workflow definitions. Active versions are pinned for in-flight runs — new versions never shift running executions."
    >
      <template #actions>
        <button class="button button-secondary" type="button" @click="refresh" aria-label="Refresh workflows" style="border-radius:999px">
          <RefreshCw :size="15" aria-hidden="true" />
          Refresh
        </button>
      </template>
    </PageHeader>

    <!-- premium metric bento -->
    <section class="metric-grid" style="margin-bottom:20px">
      <article class="metric-card card-sheen" style="min-height:88px;padding:16px 20px;display:flex;align-items:center;gap:14px">
        <span style="display:grid;place-items:center;width:36px;height:36px;border-radius:10px;background:var(--brand-weak-bg);color:var(--brand-weak-text);border:1px solid var(--brand-weak-border)"><Layers :size="16" aria-hidden="true" /></span>
        <div>
          <p style="margin:0;color:var(--text-muted);font-size:11px;letter-spacing:0.08em;text-transform:uppercase;font-weight:600">Catalog</p>
          <strong style="font-size:18px;margin:2px 0 0">{{ totalLabel }}</strong>
          <span style="margin:0">page size {{ pageLimit }} · keyset</span>
        </div>
      </article>
      <article class="metric-card card-sheen" style="min-height:88px;padding:16px 20px;display:flex;align-items:center;gap:14px">
        <span style="display:grid;place-items:center;width:36px;height:36px;border-radius:10px;background:var(--success-bg);color:var(--success-text);border:1px solid rgba(23,114,69,0.18)"><Sparkles :size="16" aria-hidden="true" /></span>
        <div>
          <p style="margin:0;color:var(--text-muted);font-size:11px;letter-spacing:0.08em;text-transform:uppercase;font-weight:600">Active</p>
          <strong style="font-size:18px;margin:2px 0 0;color:var(--success-text)">{{ activeCount }}</strong>
          <span>ready to trigger</span>
        </div>
      </article>
      <article class="metric-card card-sheen" style="min-height:88px;padding:16px 20px;display:flex;align-items:center;gap:14px">
        <span style="display:grid;place-items:center;width:36px;height:36px;border-radius:10px;background:var(--neutral-bg);color:var(--neutral-text);border:1px solid var(--border)"><Workflow :size="16" aria-hidden="true" /></span>
        <div>
          <p style="margin:0;color:var(--text-muted);font-size:11px;letter-spacing:0.08em;text-transform:uppercase;font-weight:600">Draft / other</p>
          <strong style="font-size:18px;margin:2px 0 0">{{ draftCount }}</strong>
          <span>awaiting activation</span>
        </div>
      </article>
    </section>

    <section class="panel panel--elevated table-shell">
      <div class="panel-heading">
        <div>
          <p class="eyebrow">Collection</p>
          <h2>Workflow catalog</h2>
          <p class="inline-note" style="margin-top:4px">Tenant-scoped · linear steps · unique keys</p>
        </div>
        <span class="pill" aria-hidden="true" style="border-radius:999px"><Workflow :size="12" style="margin-right:6px" />{{ items.length }} items</span>
      </div>

      <LoadingState v-if="pending" />
      <ErrorState v-else-if="error" :message="error" @retry="refresh" />
      <EmptyState
        v-else-if="items.length === 0"
        title="No workflows yet"
        description="Workflows define the operations AI Workforce can execute — from webhook-triggered triage to AI-enriched jobs."
        hint="Create one via: pnpm workflow:create <tenantId> &quot;name&quot; [source]"
      />

      <template v-else>
        <div class="table-wrap">
          <table>
            <caption class="visually-hidden">Workflows</caption>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Status</th>
                <th scope="col">Active version</th>
                <th scope="col">Trigger</th>
                <th scope="col">Updated</th>
                <th scope="col">Runs</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="workflow in items" :key="workflow.id" style="transition:background 0.15s ease">
                <td>
                  <div style="display:flex;align-items:center;gap:10px">
                    <span style="display:grid;place-items:center;width:28px;height:28px;border-radius:8px;background:var(--surface-sunken);border:1px solid var(--border-subtle);color:var(--text-secondary)"><Workflow :size="14" aria-hidden="true" /></span>
                    <div>
                      <strong>{{ workflow.name }}</strong>
                      <p class="mono-text" :title="workflow.id" style="margin:0">{{ workflow.id.slice(0,8) }}…{{ workflow.id.slice(-4) }}</p>
                    </div>
                  </div>
                </td>
                <td>
                  <span style="display:inline-flex;align-items:center;gap:8px">
                    <span class="status-dot" :class="workflow.status === 'active' ? 'status-dot--success' : 'status-dot--queued'" aria-hidden="true" />
                    <StatusBadge :status="workflow.status" />
                  </span>
                </td>
                <td><span class="pill" style="font-family:var(--font-mono);font-size:12px">{{ workflow.activeVersion?.version ?? "None" }}</span></td>
                <td><span class="pill" style="text-transform:capitalize">{{ workflow.activeVersion?.triggerType ?? "Not active" }}</span></td>
                <td style="white-space:nowrap">{{ formatDate(workflow.updatedAt) }}</td>
                <td>
                  <NuxtLink
                    class="text-link"
                    :to="`/runs?workflowId=${encodeURIComponent(workflow.id)}`"
                  >
                    View runs <ArrowRight :size="14" aria-hidden="true" />
                  </NuxtLink>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="card-list" role="list">
          <div v-for="workflow in items" :key="workflow.id" class="app-card" role="listitem" style="padding:16px">
            <div style="display:flex;justify-content:space-between;gap:12px;align-items:start">
              <div style="display:flex;gap:10px;align-items:center">
                <span style="display:grid;place-items:center;width:32px;height:32px;border-radius:10px;background:var(--surface-sunken);border:1px solid var(--border)"><Workflow :size="16" aria-hidden="true" /></span>
                <strong>{{ workflow.name }}</strong>
              </div>
              <span style="display:inline-flex;gap:6px;align-items:center"><span class="status-dot" :class="workflow.status === 'active' ? 'status-dot--success' : ''" aria-hidden="true" /><StatusBadge :status="workflow.status" /></span>
            </div>
            <p class="mono-text" style="font-size:11px;word-break:break-all;margin:8px 0 0">{{ workflow.id }}</p>
            <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">
              <span class="pill">v{{ workflow.activeVersion?.version ?? "—" }}</span>
              <span class="pill" style="text-transform:capitalize">{{ workflow.activeVersion?.triggerType ?? "Not active" }}</span>
              <span class="pill">{{ formatDate(workflow.updatedAt) }}</span>
            </div>
            <NuxtLink class="text-link" style="margin-top:12px" :to="`/runs?workflowId=${encodeURIComponent(workflow.id)}`">View runs →</NuxtLink>
          </div>
        </div>
      </template>

      <div v-if="items.length > 0" class="pagination-row" style="margin-top:12px;padding-top:14px;border-top:1px solid var(--border-subtle)">
        <p class="inline-note">Keyset pagination · cursor-based · tenant-isolated</p>
        <div class="page-toolbar">
          <button class="button button-secondary" type="button" :disabled="!hasPrevious" @click="loadPrevious" style="border-radius:999px">Previous</button>
          <button class="button button-secondary" type="button" :disabled="!hasNext" @click="loadNext" style="border-radius:999px">Next</button>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.visually-hidden { position:absolute; left:-9999px; }
tbody tr:hover { background: var(--surface-raised); }
</style>
