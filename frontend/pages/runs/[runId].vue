<script setup lang="ts">
import { ArrowLeft, Bot, Clock3, Database, Wrench } from '@lucide/vue';
import { computed } from 'vue';

import { formatDate, formatDuration, formatNumber } from '~/lib/format';

const route = useRoute();
const api = useApiClient();
const runId = computed(() => String(route.params.runId));
const { data: inspection, error, pending, refresh } = useResource(() => api.getRun(runId.value));
</script>

<template>
  <div>
    <PageHeader title="Run details" description="Safe, tenant-scoped execution inspection from the Fastify API.">
      <template #actions>
        <NuxtLink class="button button-secondary" to="/runs">
          <ArrowLeft :size="16" aria-hidden="true" />
          Runs
        </NuxtLink>
      </template>
    </PageHeader>

    <LoadingState v-if="pending" />
    <ErrorState v-else-if="error" :message="error" @retry="refresh" />

    <template v-else-if="inspection">
      <section class="run-hero panel">
        <div>
          <p class="eyebrow">{{ inspection.workflow.name }}</p>
          <h2>{{ inspection.run.id }}</h2>
          <p class="mono-text">Version {{ inspection.version.version }} · {{ inspection.version.triggerType }} trigger</p>
        </div>
        <StatusBadge :status="inspection.run.status" />
      </section>

      <section class="metric-grid metric-grid-detail">
        <article class="metric-card compact-card">
          <p>Started</p>
          <strong>{{ formatDate(inspection.run.startedAt) }}</strong>
          <span>Created {{ formatDate(inspection.run.createdAt) }}</span>
        </article>
        <article class="metric-card compact-card">
          <p>Current step</p>
          <strong>{{ inspection.run.currentStepKey ?? 'Complete' }}</strong>
          <span>Workflow status: {{ inspection.workflow.status }}</span>
        </article>
        <article class="metric-card compact-card">
          <p>LLM usage</p>
          <strong>{{ formatNumber(inspection.usageTotals.totalTokens) }} tokens</strong>
          <span>{{ inspection.usageTotals.rounds }} provider rounds</span>
        </article>
      </section>

      <section v-if="inspection.run.error" class="panel failure-panel">
        <p class="eyebrow">Run failure</p>
        <h2>{{ inspection.run.error.code }}</h2>
        <p>{{ inspection.run.error.message }}</p>
      </section>

      <section class="panel table-panel">
        <div class="panel-heading">
          <div>
            <p class="eyebrow">Execution</p>
            <h2>Steps</h2>
          </div>
          <Clock3 :size="20" aria-hidden="true" />
        </div>
        <EmptyState v-if="inspection.steps.length === 0" title="No step executions yet" description="This run has not recorded a workflow step execution." />
        <div v-else class="table-wrap">
          <table>
            <thead><tr><th>Step</th><th>Type</th><th>Attempt</th><th>Status</th><th>Duration</th><th>Error</th></tr></thead>
            <tbody>
              <tr v-for="step in inspection.steps" :key="step.id">
                <td><strong>{{ step.stepKey }}</strong></td>
                <td>{{ step.stepType }}</td>
                <td>{{ step.attempt }}</td>
                <td><StatusBadge :status="step.status" /></td>
                <td>{{ formatDuration(step.durationMs) }}</td>
                <td>{{ step.error?.message ?? '—' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section class="detail-grid">
        <article class="panel table-panel">
          <div class="panel-heading"><div><p class="eyebrow">Queue</p><h2>Jobs</h2></div><Database :size="20" /></div>
          <EmptyState v-if="inspection.jobs.length === 0" title="No jobs recorded" description="No queued work is associated with this run." />
          <div v-else class="table-wrap">
            <table><thead><tr><th>Step</th><th>Status</th><th>Retries</th><th>Lease</th></tr></thead>
              <tbody><tr v-for="job in inspection.jobs" :key="job.id"><td>{{ job.stepKey }}</td><td><StatusBadge :status="job.status" /></td><td>{{ job.retryCount }} / {{ job.maxAttempts }}</td><td>{{ job.leased ? 'Active' : '—' }}</td></tr></tbody>
            </table>
          </div>
        </article>
        <article class="panel table-panel">
          <div class="panel-heading"><div><p class="eyebrow">Tool activity</p><h2>LLM tools</h2></div><Wrench :size="20" /></div>
          <EmptyState v-if="inspection.tools.length === 0" title="No tool activity" description="No LLM step has used an external tool in this run." />
          <div v-else class="activity-list">
            <div v-for="tool in inspection.tools" :key="tool.stepKey" class="activity-row">
              <div><strong>{{ tool.stepKey }}</strong><p>{{ tool.rounds }} model rounds</p></div>
              <span class="activity-meta">{{ tool.usedTools ? `${tool.toolRounds} tool rounds` : "No tools" }}</span>
            </div>
          </div>
        </article>
      </section>

      <section class="panel context-panel">
        <div class="panel-heading"><div><p class="eyebrow">Trigger</p><h2>{{ inspection.event.source }}</h2></div><Bot :size="20" /></div>
        <dl class="definition-list">
          <div><dt>Received</dt><dd>{{ formatDate(inspection.event.receivedAt) }}</dd></div>
          <div><dt>Payload summary</dt><dd>{{ inspection.event.payloadSummary.preview }}</dd></div>
          <div><dt>Run context summary</dt><dd>{{ inspection.run.contextSummary.preview }}</dd></div>
        </dl>
      </section>
    </template>
  </div>
</template>
