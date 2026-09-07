<script setup lang="ts">
import {
  ArrowRight,
  ArrowUpRight,
  Cable,
  CircleCheck,
  Database,
  Workflow,
} from "@lucide/vue";
import { computed } from "vue";

import { formatDate } from "~/lib/format";

const api = useApiClient();

const { data: health, refresh: refreshHealth } = useResource(() =>
  api.getHealth(),
);
const { data: workflows, refresh: refreshWorkflows } = useResource(() =>
  api.listWorkflows(5),
);
const {
  data: runs,
  error: runsError,
  pending: runsPending,
  refresh: refreshRuns,
} = useResource(() => api.listRuns({ limit: 5 }));
const { data: connections, refresh: refreshConnections } = useResource(() =>
  api.listConnections(5),
);

const runCountLabel = computed(() => {
  const list = runs.value?.items ?? [];
  if (list.length === 0) return "No runs";
  const active = list.filter(
    (item) =>
      item.status === "running" ||
      item.status === "queued" ||
      item.status === "waiting",
  ).length;
  return active === 0 ? `${list.length} recent` : `${active} active`;
});
</script>

<template>
  <div class="dashboard-hero">
    <PageHeader
      title="Operations overview"
      description="Live workflow, run, and connection visibility."
    />

    <section class="dashboard-top" aria-label="Workspace summary">
      <article class="panel panel-emphasis dashboard-surface">
        <div class="dashboard-intro">
          <div class="panel-heading">
            <div>
              <p class="eyebrow">Control center</p>
              <h2>Track automation in real time</h2>
            </div>
            <StatusBadge v-if="health" :status="health.status" />
          </div>
          <p class="panel-copy">
            Run history, workflow definitions, and provider connections are now
            available as authenticated collection APIs and rendered directly in
            this workspace.
          </p>
          <div class="dashboard-actions">
            <NuxtLink class="button button-primary" to="/runs">
              Open run timeline <ArrowUpRight :size="14" aria-hidden="true" />
            </NuxtLink>
            <button
              class="button button-secondary"
              type="button"
              @click="
                refreshHealth();
                refreshWorkflows();
                refreshRuns();
                refreshConnections();
              "
            >
              Refresh all
            </button>
          </div>
        </div>
      </article>

      <article class="panel quick-links">
        <NuxtLink class="quick-link" to="/workflows">
          <div>
            <strong>Workflows</strong>
            <p>{{ workflows?.items.length ?? 0 }} recently updated</p>
          </div>
          <Workflow :size="18" aria-hidden="true" />
        </NuxtLink>
        <NuxtLink class="quick-link" to="/runs">
          <div>
            <strong>Runs</strong>
            <p>{{ runCountLabel }}</p>
          </div>
          <CircleCheck :size="18" aria-hidden="true" />
        </NuxtLink>
        <NuxtLink class="quick-link" to="/connections">
          <div>
            <strong>Connections</strong>
            <p>{{ connections?.items.length ?? 0 }} configured</p>
          </div>
          <Cable :size="18" aria-hidden="true" />
        </NuxtLink>
      </article>
    </section>

    <section class="metric-grid">
      <article class="metric-card">
        <div class="metric-icon metric-blue"><Workflow :size="20" /></div>
        <p>Workflows</p>
        <strong>{{ workflows?.items.length ?? 0 }}</strong>
        <span>Latest active/draft definitions for this tenant.</span>
      </article>
      <article class="metric-card">
        <div class="metric-icon metric-green"><CircleCheck :size="20" /></div>
        <p>Recent runs</p>
        <strong>{{ runs?.items.length ?? 0 }}</strong>
        <span>Newest execution records from the run timeline.</span>
      </article>
      <article class="metric-card">
        <div class="metric-icon metric-amber"><Database :size="20" /></div>
        <p>Connections</p>
        <strong>{{ connections?.items.length ?? 0 }}</strong>
        <span>Provider credentials are encrypted and metadata-only here.</span>
      </article>
    </section>

    <section class="content-grid">
      <article class="panel table-panel">
        <div class="panel-heading">
          <div>
            <p class="eyebrow">Recent activity</p>
            <h2>Newest runs</h2>
          </div>
          <NuxtLink class="text-link" to="/runs">
            All runs <ArrowRight :size="14" aria-hidden="true" />
          </NuxtLink>
        </div>
        <LoadingState v-if="runsPending" />
        <ErrorState
          v-else-if="runsError"
          :message="runsError"
          @retry="refreshRuns"
        />
        <EmptyState
          v-else-if="(runs?.items.length ?? 0) === 0"
          title="No runs yet"
          description="Trigger a workflow to populate this timeline."
        />
        <div v-else class="recent-list">
          <div
            v-for="run in runs?.items ?? []"
            :key="run.id"
            class="recent-row"
          >
            <div>
              <NuxtLink
                class="table-link"
                :to="`/runs/${encodeURIComponent(run.id)}`"
              >
                <strong>{{ run.workflowName }}</strong>
              </NuxtLink>
              <p>
                {{ formatDate(run.createdAt) }} ·
                {{ run.currentStepKey ?? "Complete" }}
              </p>
            </div>
            <StatusBadge :status="run.status" />
          </div>
        </div>
      </article>

      <article class="panel">
        <div class="panel-heading">
          <div>
            <p class="eyebrow">Run inspection</p>
            <h2>Open a specific run</h2>
          </div>
        </div>
        <p class="panel-copy">
          Paste a run id to load detailed step, job, usage, and trigger details.
        </p>
        <RunLookup />
      </article>
    </section>
  </div>
</template>
