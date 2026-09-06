<script setup lang="ts">
import { Cable, RefreshCw } from "@lucide/vue";
import { computed, ref } from "vue";

import { formatDate } from "~/lib/format";

const api = useApiClient();
const pageLimit = 20;
const cursor = ref<string | undefined>();
const previousCursors = ref<Array<string | undefined>>([]);

const { data, error, pending, refresh } = useResource(() =>
  api.listConnections(pageLimit, cursor.value),
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
      title="Connections"
      description="Provider integrations available to this tenant's workflows."
    />

    <section class="panel table-shell">
      <div class="panel-heading">
        <div>
          <p class="eyebrow">Collection</p>
          <h2>Connection registry</h2>
        </div>
        <button class="button button-secondary" type="button" @click="refresh">
          <RefreshCw :size="15" aria-hidden="true" />
          Refresh
        </button>
      </div>

      <LoadingState v-if="pending" />
      <ErrorState v-else-if="error" :message="error" @retry="refresh" />
      <EmptyState
        v-else-if="items.length === 0"
        title="No connections found"
        description="Create encrypted provider credentials with the backend CLI and refresh this page."
      />

      <div v-else class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Provider</th>
              <th>Status</th>
              <th>Metadata</th>
              <th>Last used</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="connection in items" :key="connection.id">
              <td>
                <strong>{{ connection.name }}</strong>
                <p class="mono-text">{{ connection.id }}</p>
              </td>
              <td>{{ connection.provider }}</td>
              <td><StatusBadge :status="connection.status" /></td>
              <td>
                <span class="pill"
                  >{{ Object.keys(connection.metadata).length }} fields</span
                >
              </td>
              <td>{{ formatDate(connection.lastUsedAt) }}</td>
              <td>{{ formatDate(connection.updatedAt) }}</td>
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

    <section class="callout-row">
      <Cable :size="18" aria-hidden="true" />
      <p>
        Credential values remain encrypted at rest and are never rendered in
        this UI.
      </p>
    </section>
  </div>
</template>
