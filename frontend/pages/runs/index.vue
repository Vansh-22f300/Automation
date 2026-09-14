<script setup lang="ts">
import { ListFilter, PlaySquare } from "@lucide/vue";
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

    <section class="panel table-shell">
      <div class="panel-heading">
        <div>
          <p class="eyebrow">Collection</p>
          <h2>Run history</h2>
          <p class="inline-note" style="margin-top:4px">{{ items.length === 0 ? 'No results' : items.length + ' runs' }} · filters apply to tenant only</p>
        </div>
        <span class="pill" aria-hidden="true"><PlaySquare :size="12" style="margin-right:6px"/>{{ items.length }} visible</span>
      </div>

      <form class="table-toolbar" @submit.prevent="applyFilters" aria-label="Run filters">
        <div class="filters">
          <label class="hidden-sm" for="run-status">Status</label>
          <select id="run-status" v-model="status" class="filter-select" aria-label="Filter by status">
            <option value="">All statuses</option>
            <option value="queued">Queued</option>
            <option value="running">Running</option>
            <option value="waiting">Waiting</option>
            <option value="succeeded">Succeeded</option>
            <option value="failed">Failed</option>
            <option value="cancelled">Cancelled</option>
          </select>

          <label class="hidden-sm" for="workflow-filter">Workflow</label>
          <select id="workflow-filter" v-model="workflowId" class="filter-select" aria-label="Filter by workflow">
            <option value="">All workflows</option>
            <option v-for="workflow in workflows?.items ?? []" :key="workflow.id" :value="workflow.id">{{ workflow.name }}</option>
          </select>
        </div>
        <div class="page-toolbar">
          <button class="button button-secondary" type="submit">
            <ListFilter :size="14" aria-hidden="true" />
            Apply filters
          </button>
          <button v-if="status || workflowId" class="button button-secondary" type="button" @click="clearFilters">Clear</button>
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
                  <NuxtLink class="table-link" :to="`/runs/${encodeURIComponent(run.id)}`"><strong style="font-family:var(--font-mono);font-size:12px">{{ run.id.slice(0,8) }}…{{ run.id.slice(-4) }}</strong></NuxtLink>
                  <p class="mono-text" style="font-size:11px" :title="run.id">{{ run.id }}</p>
                </td>
                <td>
                  <strong>{{ run.workflowName }}</strong>
                  <p class="mono-text">{{ run.workflowId.slice(0,8) }}…</p>
                </td>
                <td><StatusBadge :status="run.status" /></td>
                <td><span class="pill" style="font-family:var(--font-mono);font-size:12px">{{ run.currentStepKey ?? "Complete" }}</span></td>
                <td>{{ formatDate(run.startedAt ?? run.createdAt) }}</td>
                <td>{{ formatDate(run.finishedAt) }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="card-list" role="list">
          <div v-for="run in items" :key="run.id" class="data-card" role="listitem">
            <div style="display:flex;justify-content:space-between;gap:8px;align-items:center">
              <NuxtLink class="table-link" :to="`/runs/${encodeURIComponent(run.id)}`"><strong style="font-family:var(--font-mono);font-size:12px">{{ run.id.slice(0,8) }}…</strong></NuxtLink>
              <StatusBadge :status="run.status" />
            </div>
            <p style="margin:6px 0 0;font-size:13px;font-weight:500">{{ run.workflowName }}</p>
            <p class="mono-text" style="font-size:11px">{{ run.currentStepKey ?? 'Complete' }} · {{ formatDate(run.startedAt ?? run.createdAt) }}</p>
          </div>
        </div>
      </template>

      <div v-if="items.length > 0" class="pagination-row">
        <p class="inline-note">Cursor pagination · tenant-scoped</p>
        <div class="page-toolbar">
          <button class="button button-secondary" type="button" :disabled="!hasPrevious" @click="loadPrevious">Previous</button>
          <button class="button button-secondary" type="button" :disabled="!hasNext" @click="loadNext">Next</button>
        </div>
      </div>
    </section>

    <section class="panel">
      <div class="panel-heading">
        <div>
          <p class="eyebrow">Run lookup</p>
          <h2>Open a specific run</h2>
        </div>
      </div>
      <p class="panel-copy">Enter a run ID to view its execution — steps, jobs, LLM usage and tool activity.</p>
      <RunLookup />
    </section>
  </div>
</template>

<style scoped>
.visually-hidden { position:absolute; left:-9999px; }
</style>
