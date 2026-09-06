<script setup lang="ts">
import { ListFilter, Search } from "@lucide/vue";
import { computed, ref } from "vue";

import { formatDate } from "~/lib/format";

const route = useRoute();
const api = useApiClient();
const pageLimit = 20;
const cursor = ref<string | undefined>();
const previousCursors = ref<Array<string | undefined>>([]);

const status = ref(
  typeof route.query.status === "string" ? route.query.status : "",
);
const workflowId = ref(
  typeof route.query.workflowId === "string" ? route.query.workflowId : "",
);

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
</script>

<template>
  <div>
    <PageHeader
      title="Runs"
      description="Execution history across workflows for the current tenant."
    />

    <section class="panel panel-emphasis">
      <div class="panel-heading">
        <div>
          <p class="eyebrow">Run inspection</p>
          <h2>Open a specific run</h2>
        </div>
        <Search :size="20" aria-hidden="true" />
      </div>
      <p class="panel-copy">
        Paste a run ID to load execution details, step outcomes, queue jobs,
        usage totals, and safe error metadata.
      </p>
      <RunLookup />
    </section>

    <section class="panel table-shell">
      <div class="panel-heading">
        <div>
          <p class="eyebrow">Collection</p>
          <h2>Run history</h2>
        </div>
      </div>

      <form class="table-toolbar" @submit.prevent="applyFilters">
        <div class="filters">
          <label class="hidden-sm" for="run-status">Status</label>
          <select id="run-status" v-model="status" class="filter-select">
            <option value="">All statuses</option>
            <option value="queued">Queued</option>
            <option value="running">Running</option>
            <option value="waiting">Waiting</option>
            <option value="succeeded">Succeeded</option>
            <option value="failed">Failed</option>
            <option value="cancelled">Cancelled</option>
          </select>

          <label class="hidden-sm" for="workflow-filter">Workflow</label>
          <select
            id="workflow-filter"
            v-model="workflowId"
            class="filter-select"
          >
            <option value="">All workflows</option>
            <option
              v-for="workflow in workflows?.items ?? []"
              :key="workflow.id"
              :value="workflow.id"
            >
              {{ workflow.name }}
            </option>
          </select>
        </div>
        <div class="page-toolbar">
          <button class="button button-secondary" type="submit">
            <ListFilter :size="14" aria-hidden="true" />
            Apply filters
          </button>
        </div>
      </form>

      <LoadingState v-if="pending" />
      <ErrorState v-else-if="error" :message="error" @retry="refresh" />
      <EmptyState
        v-else-if="items.length === 0"
        title="No runs match this view"
        description="Trigger a workflow or clear filters to inspect available runs."
      />

      <div v-else class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Run</th>
              <th>Workflow</th>
              <th>Status</th>
              <th>Current step</th>
              <th>Started</th>
              <th>Finished</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="run in items" :key="run.id">
              <td>
                <NuxtLink
                  class="table-link"
                  :to="`/runs/${encodeURIComponent(run.id)}`"
                >
                  <strong>{{ run.id }}</strong>
                </NuxtLink>
              </td>
              <td>
                <strong>{{ run.workflowName }}</strong>
                <p class="mono-text">{{ run.workflowId }}</p>
              </td>
              <td><StatusBadge :status="run.status" /></td>
              <td>{{ run.currentStepKey ?? "Complete" }}</td>
              <td>{{ formatDate(run.startedAt ?? run.createdAt) }}</td>
              <td>{{ formatDate(run.finishedAt) }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-if="items.length > 0" class="pagination-row">
        <p class="inline-note">Page size {{ pageLimit }}</p>
        <div class="page-toolbar">
          <button
            class="button button-secondary"
            type="button"
            :disabled="!hasPrevious"
            @click="loadPrevious"
          >
            Previous
          </button>
          <button
            class="button button-secondary"
            type="button"
            :disabled="!hasNext"
            @click="loadNext"
          >
            Next
          </button>
        </div>
      </div>
    </section>
  </div>
</template>
