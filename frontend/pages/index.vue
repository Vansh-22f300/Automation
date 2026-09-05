<script setup lang="ts">
import { ArrowUpRight, CircleCheck, Database, Workflow } from '@lucide/vue';

const api = useApiClient();
const { data: health, error, pending, refresh } = useResource(() => api.getHealth());
</script>

<template>
  <div>
    <PageHeader title="Operations overview" description="A focused view of your workflow automation workspace." />

    <section class="metric-grid" aria-label="Workspace summary">
      <article class="metric-card">
        <div class="metric-icon metric-blue"><Workflow :size="20" /></div>
        <p>Workflows</p>
        <strong>Unavailable</strong>
        <span>The API does not yet expose a workflow list.</span>
      </article>
      <article class="metric-card">
        <div class="metric-icon metric-green"><CircleCheck :size="20" /></div>
        <p>Recent runs</p>
        <strong>Unavailable</strong>
        <span>The API does not yet expose a run list.</span>
      </article>
      <article class="metric-card">
        <div class="metric-icon metric-amber"><Database :size="20" /></div>
        <p>Connections</p>
        <strong>Unavailable</strong>
        <span>The API does not yet expose a connection list.</span>
      </article>
    </section>

    <section class="content-grid">
      <article class="panel panel-emphasis">
        <div class="panel-heading">
          <div>
            <p class="eyebrow">Run inspection</p>
            <h2>Follow a workflow run</h2>
          </div>
          <NuxtLink class="text-link" to="/runs">Run workspace <ArrowUpRight :size="15" /></NuxtLink>
        </div>
        <p class="panel-copy">Open the existing safe run-inspection view with an ID from the webhook inspection CLI or a backend response.</p>
        <RunLookup />
      </article>

      <article class="panel">
        <div class="panel-heading">
          <div>
            <p class="eyebrow">Backend status</p>
            <h2>Fastify API</h2>
          </div>
          <StatusBadge v-if="health" :status="health.status" />
        </div>
        <LoadingState v-if="pending" />
        <ErrorState v-else-if="error" :message="error" @retry="refresh" />
        <div v-else class="backend-healthy">
          <span class="live-indicator" />
          <div>
            <strong>Backend is reachable</strong>
            <p>The dashboard is connected through the local development proxy.</p>
          </div>
        </div>
      </article>
    </section>

    <section class="panel activity-panel">
      <div class="panel-heading">
        <div>
          <p class="eyebrow">Recent activity</p>
          <h2>Run activity becomes available with the list endpoint</h2>
        </div>
      </div>
      <p class="panel-copy">The current backend intentionally exposes single-run inspection only. This panel will use the future tenant-scoped run list without changing the application shell.</p>
    </section>
  </div>
</template>
