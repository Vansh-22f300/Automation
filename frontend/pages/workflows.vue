<script setup lang="ts">
import { ArrowRight, RefreshCw, Workflow } from "@lucide/vue";
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
        <button class="button button-secondary" type="button" @click="refresh" aria-label="Refresh workflows">
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
          <p class="inline-note" style="margin-top:4px">{{ totalLabel }} · page size {{ pageLimit }}</p>
        </div>
        <span class="pill" aria-hidden="true"><Workflow :size="12" style="margin-right:6px" />{{ items.length }} items</span>
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
              <tr v-for="workflow in items" :key="workflow.id">
                <td>
                  <strong>{{ workflow.name }}</strong>
                  <p class="mono-text" :title="workflow.id">{{ workflow.id }}</p>
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

        <div class="card-list" role="list">
          <div v-for="workflow in items" :key="workflow.id" class="data-card" role="listitem">
            <div style="display:flex;justify-content:space-between;gap:12px;align-items:start">
              <strong>{{ workflow.name }}</strong>
              <StatusBadge :status="workflow.status" />
            </div>
            <p class="mono-text" style="font-size:11px;word-break:break-all">{{ workflow.id }}</p>
            <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">
              <span class="pill">v{{ workflow.activeVersion?.version ?? "—" }}</span>
              <span class="pill">{{ workflow.activeVersion?.triggerType ?? "Not active" }}</span>
              <span class="pill">{{ formatDate(workflow.updatedAt) }}</span>
            </div>
            <NuxtLink class="text-link" style="margin-top:12px" :to="`/runs?workflowId=${encodeURIComponent(workflow.id)}`">View runs →</NuxtLink>
          </div>
        </div>
      </template>

      <div v-if="items.length > 0" class="pagination-row">
        <p class="inline-note">Keyset pagination · cursor-based</p>
        <div class="page-toolbar">
          <button class="button button-secondary" type="button" :disabled="!hasPrevious" @click="loadPrevious">Previous</button>
          <button class="button button-secondary" type="button" :disabled="!hasNext" @click="loadNext">Next</button>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.visually-hidden { position:absolute; left:-9999px; }
</style>
