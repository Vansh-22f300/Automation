<script setup lang="ts">
import { ArrowRight, RefreshCw } from "@lucide/vue";
import { computed, ref } from "vue";

import { formatDate } from "~/lib/format";

const api = useApiClient();
const pageLimit = 20;
const cursor = ref<string | undefined>();
const previousCursors = ref<Array<string | undefined>>([]);

const { data, error, pending, refresh } = useResource(() =>
  api.listWorkflows(pageLimit, cursor.value),
);

const items = computed(() => data.value?.items ?? []);
const hasPrevious = computed(() => previousCursors.value.length > 0);
const hasNext = computed(() => (data.value?.page.nextCursor ?? null) !== null);

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
      description="Tenant-scoped workflow definitions and active versions."
    >
      <template #actions>
        <button class="button button-secondary" type="button" @click="refresh">
          <RefreshCw :size="15" aria-hidden="true" />
          Refresh
        </button>
      </template>
    </PageHeader>

    <section class="panel table-shell">
      <div class="panel-heading">
        <div>
          <p class="eyebrow">Collection</p>
          <h2>Workflow catalog</h2>
        </div>
      </div>

      <LoadingState v-if="pending" />
      <ErrorState v-else-if="error" :message="error" @retry="refresh" />
      <EmptyState
        v-else-if="items.length === 0"
        title="No workflows found"
        description="Create a workflow from the backend CLI, then refresh this view."
      />

      <div v-else class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Status</th>
              <th>Active version</th>
              <th>Trigger</th>
              <th>Updated</th>
              <th>Runs</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="workflow in items" :key="workflow.id">
              <td>
                <strong>{{ workflow.name }}</strong>
                <p class="mono-text">{{ workflow.id }}</p>
              </td>
              <td><StatusBadge :status="workflow.status" /></td>
              <td>{{ workflow.activeVersion?.version ?? "None" }}</td>
              <td>{{ workflow.activeVersion?.triggerType ?? "Not active" }}</td>
              <td>{{ formatDate(workflow.updatedAt) }}</td>
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
