<script setup lang="ts">
import { Activity, ListFilter, PlaySquare, Sparkles } from "@lucide/vue";
import { computed, ref, watch } from "vue";
import { formatDate } from "~/lib/format";

const route = useRoute();
const router = useRouter();
const api = useApiClient();
const pageLimit = 20;
const cursor = ref<string | undefined>(typeof route.query.cursor === 'string' ? route.query.cursor : undefined);
const previousCursors = ref<Array<string | undefined>>([]);

const status = ref(typeof route.query.status === 'string' ? route.query.status : "");
const workflowId = ref(typeof route.query.workflowId === 'string' ? route.query.workflowId : "");

const { data, error, pending, refresh } = useResource(() =>
  api.listRuns({
    limit: pageLimit,
    cursor: cursor.value,
    status: status.value === "" ? undefined : status.value,
    workflowId: workflowId.value === "" ? undefined : workflowId.value,
  }),
);

const { data: workflows } = useResource(() => api.listWorkflows(100));

const items = computed(() => data.value?.items ?? []);
const hasPrevious = computed(() => previousCursors.value.length > 0);
const hasNext = computed(() => (data.value?.page.nextCursor ?? null) !== null);
const succeeded = computed(() => items.value.filter(r => r.status === 'succeeded').length);
const active = computed(() => items.value.filter(r => ['running','queued','waiting'].includes(r.status)).length);

watch([status, workflowId, cursor], ([s, w, c]) => {
  router.replace({ query: { ...route.query, status: s || undefined, workflowId: w || undefined, cursor: c || undefined } });
});

async function applyFilters(): Promise<void> {
  cursor.value = undefined;
  previousCursors.value = [];
  await refresh();
}

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

function clearFilters() {
  status.value = "";
  workflowId.value = "";
  cursor.value = undefined;
  previousCursors.value = [];
  refresh();
}
</script>

<template>
  <div>
    <PageHeader
      title="Runs"
      eyebrow="Execution"
      description="Durable execution history — every trigger, step and job, tenant-isolated and inspectable."
    />

    <section class="metric-grid" style="margin-bottom:20px">
      <article class="metric-card card-sheen" style="min-height:88px;padding:16px 20px;display:flex;align-items:center;gap:14px">
        <span style="display:grid;place-items:center;width:36px;height:36px;border-radius:10px;background:var(--brand-weak-bg);color:var(--brand-weak-text);border:1px solid var(--brand-weak-border)"><Activity :size="16" aria-hidden="true" /></span>
        <div>
          <p style="margin:0;color:var(--text-muted);font-size:11px;letter-spacing:0.08em;text-transform:uppercase;font-weight:600">Visible</p>
          <strong style="font-size:18px;margin:2px 0 0">{{ items.length }} runs</strong>
          <span>tenant-scoped · live</span>
        </div>
      </article>
      <article class="metric-card card-sheen" style="min-height:88px;padding:16px 20px;display:flex;align-items:center;gap:14px">
        <span style="display:grid;place-items:center;width:36px;height:36px;border-radius:10px;background:var(--success-bg);color:var(--success-text);border:1px solid rgba(23,114,69,0.18)"><PlaySquare :size="16" aria-hidden="true" /></span>
        <div>
          <p style="margin:0;color:var(--text-muted);font-size:11px;letter-spacing:0.08em;text-transform:uppercase;font-weight:600">Succeeded</p>
          <strong style="font-size:18px;margin:2px 0 0;color:var(--success-text)">{{ succeeded }}</strong>
          <span>completed clean</span>
        </div>
      </article>
      <article class="metric-card card-sheen" style="min-height:88px;padding:16px 20px;display:flex;align-items:center;gap:14px">
        <span style="display:grid;place-items:center;width:36px;height:36px;border-radius:10px;background:var(--info-bg);color:var(--info-text);border:1px solid rgba(23,92,211,0.18)"><Sparkles :size="16" aria-hidden="true" /></span>
        <div>
          <p style="margin:0;color:var(--text-muted);font-size:11px;letter-spacing:0.08em;text-transform:uppercase;font-weight:600">Active</p>
          <strong style="font-size:18px;margin:2px 0 0;color:var(--info-text)">{{ active }}</strong>
          <span>queued / running</span>
        </div>
      </article>
    </section>

    <section class="panel panel--elevated table-shell">
      <div class="panel-heading">
        <div>
          <p class="eyebrow">Collection</p>
          <h2>Run history</h2>
          <p class="inline-note" style="margin-top:4px">Filters apply to tenant only · cursor pagination</p>
        </div>
        <span class="pill" aria-hidden="true" style="border-radius:999px"><PlaySquare :size="12" style="margin-right:6px"/>{{ items.length }} visible</span>
      </div>

      <form class="table-toolbar" @submit.prevent="applyFilters" aria-label="Run filters" style="padding:12px;border:1px solid var(--border-subtle);border-radius:12px;background:var(--surface-raised)">
        <div class="filters">
          <label class="hidden-sm" for="run-status" style="font-size:12px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:var(--text-muted)">Status</label>
          <select id="run-status" v-model="status" class="filter-select" aria-label="Filter by status" style="border-radius:999px;min-width:140px">
            <option value="">All statuses</option>
            <option value="queued">Queued</option>
            <option value="running">Running</option>
            <option value="waiting">Waiting</option>
            <option value="succeeded">Succeeded</option>
            <option value="failed">Failed</option>
            <option value="cancelled">Cancelled</option>
          </select>

          <label class="hidden-sm" for="workflow-filter" style="font-size:12px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:var(--text-muted)">Workflow</label>
          <select id="workflow-filter" v-model="workflowId" class="filter-select" aria-label="Filter by workflow" style="border-radius:999px;min-width:160px">
            <option value="">All workflows</option>
            <option v-for="workflow in workflows?.items ?? []" :key="workflow.id" :value="workflow.id">{{ workflow.name }}</option>
          </select>
        </div>
        <div class="page-toolbar">
          <button class="button button-primary" type="submit" style="border-radius:999px;height:36px">
            <ListFilter :size="14" aria-hidden="true" />
            Apply
          </button>
          <button v-if="status || workflowId" class="button button-secondary" type="button" @click="clearFilters" style="border-radius:999px">Clear</button>
        </div>
      </form>

      <LoadingState v-if="pending" />
      <ErrorState v-else-if="error" :message="error" @retry="refresh" />
      <EmptyState
        v-else-if="items.length === 0"
        title="No runs match this view"
        description="Trigger a workflow via webhook or clear filters to see available runs."
      />

      <template v-else>
        <div class="table-wrap">
          <table>
            <caption class="visually-hidden">Runs</caption>
            <thead>
              <tr>
                <th scope="col">Run</th>
                <th scope="col">Workflow</th>
                <th scope="col">Status</th>
                <th scope="col">Current step</th>
                <th scope="col">Started</th>
                <th scope="col">Finished</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="run in items" :key="run.id">
                <td>
                  <NuxtLink class="table-link" :to="`/runs/${encodeURIComponent(run.id)}`"><span style="display:inline-flex;align-items:center;gap:8px"><span class="status-dot" :class="run.status==='succeeded' ? 'status-dot--success' : run.status==='failed' ? 'status-dot--failed' : ['running','queued','waiting'].includes(run.status) ? 'status-dot--running' : ''" aria-hidden="true" /><strong style="font-family:var(--font-mono);font-size:12px">{{ run.id.slice(0,8) }}…{{ run.id.slice(-4) }}</strong></span></NuxtLink>
                  <p class="mono-text" style="font-size:11px;margin:2px 0 0" :title="run.id">{{ run.id }}</p>
                </td>
                <td>
                  <strong>{{ run.workflowName }}</strong>
                  <p class="mono-text" style="margin:2px 0 0">{{ run.workflowId.slice(0,8) }}…</p>
                </td>
                <td><StatusBadge :status="run.status" /></td>
                <td><span class="pill" style="font-family:var(--font-mono);font-size:11px;border-radius:999px">{{ run.currentStepKey ?? "Complete" }}</span></td>
                <td style="white-space:nowrap">{{ formatDate(run.startedAt ?? run.createdAt) }}</td>
                <td style="white-space:nowrap">{{ formatDate(run.finishedAt) }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="card-list" role="list">
          <div v-for="run in items" :key="run.id" class="app-card" role="listitem">
            <div style="display:flex;justify-content:space-between;gap:8px;align-items:center">
              <NuxtLink class="table-link" :to="`/runs/${encodeURIComponent(run.id)}`"><span style="display:inline-flex;gap:8px;align-items:center"><span class="status-dot" :class="run.status==='succeeded' ? 'status-dot--success' : run.status==='failed' ? 'status-dot--failed' : 'status-dot--running'" aria-hidden="true" /><strong style="font-family:var(--font-mono);font-size:12px">{{ run.id.slice(0,8) }}…</strong></span></NuxtLink>
              <StatusBadge :status="run.status" />
            </div>
            <p style="margin:8px 0 0;font-size:13px;font-weight:600">{{ run.workflowName }}</p>
            <p class="mono-text" style="font-size:11px;margin:2px 0 0">{{ run.currentStepKey ?? 'Complete' }} · {{ formatDate(run.startedAt ?? run.createdAt) }}</p>
            <div style="display:flex;gap:6px;margin-top:10px;flex-wrap:wrap">
              <span class="pill" style="border-radius:999px">{{ run.status }}</span>
              <span class="pill" style="border-radius:999px;font-family:var(--font-mono);font-size:11px">{{ run.currentStepKey ?? 'Complete' }}</span>
            </div>
          </div>
        </div>
      </template>

      <div v-if="items.length > 0" class="pagination-row" style="margin-top:12px;padding-top:14px;border-top:1px solid var(--border-subtle)">
        <p class="inline-note">Cursor pagination · tenant-scoped</p>
        <div class="page-toolbar">
          <button class="button button-secondary" type="button" :disabled="!hasPrevious" @click="loadPrevious" style="border-radius:999px">Previous</button>
          <button class="button button-secondary" type="button" :disabled="!hasNext" @click="loadNext" style="border-radius:999px">Next</button>
        </div>
      </div>
    </section>

    <section class="panel panel--elevated">
      <div class="panel-heading">
        <div>
          <p class="eyebrow">Run lookup</p>
          <h2>Open a specific run</h2>
        </div>
        <span class="pill" style="border-radius:999px;background:var(--surface-sunken)">inspect</span>
      </div>
      <p class="panel-copy">Enter a run ID to view its execution — steps, jobs, LLM usage and tool activity.</p>
      <RunLookup />
    </section>
  </div>
</template>

<style scoped>
.visually-hidden { position:absolute; left:-9999px; }
tbody tr:hover { background: var(--surface-raised); }
</style>
