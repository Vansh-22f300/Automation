<script setup lang="ts">
import { ArrowLeft, Bot, Clock3, Database, Wrench, Workflow } from '@lucide/vue';
import { computed } from 'vue';
import { formatDate, formatDuration, formatNumber } from '~/lib/format';

const route = useRoute();
const api = useApiClient();
const runId = computed(() => String(route.params.runId));
const { data: inspection, error, pending, refresh } = useResource(() => api.getRun(runId.value));

const durationLabel = computed(() => {
  if (!inspection.value) return '—';
  const s = inspection.value.run.startedAt;
  const f = inspection.value.run.finishedAt;
  if (!s) return 'Not started';
  if (!f) return 'Running';
  const ms = new Date(f).getTime() - new Date(s).getTime();
  return formatDuration(ms);
});
</script>

<template>
  <div>
    <PageHeader title="Run details" eyebrow="Inspection" description="Safe, tenant-scoped execution inspection — redacted summaries, not raw secrets.">
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
        <div style="min-width:0">
          <p class="eyebrow" style="display:flex;align-items:center;gap:8px"><Workflow :size="12" aria-hidden="true" />{{ inspection.workflow.name }} · v{{ inspection.version.version }}</p>
          <h2 :title="inspection.run.id" style="font-family:var(--font-mono);font-size:15px;word-break:break-all">{{ inspection.run.id }}</h2>
          <p class="mono-text" style="margin-top:6px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
            <span class="pill" style="font-family:var(--font-mono)">{{ inspection.version.triggerType }} trigger</span>
            <span class="pill">{{ inspection.workflow.status }}</span>
            <span class="pill">{{ durationLabel }}</span>
          </p>
        </div>
        <div style="display:flex;flex-direction:column;gap:8px;align-items:flex-end">
          <StatusBadge :status="inspection.run.status" />
          <span class="inline-note" style="font-family:var(--font-mono);font-size:11px;max-width:280px;word-break:break-all;text-align:right">{{ inspection.run.currentStepKey ? 'Current: ' + inspection.run.currentStepKey : 'Complete' }}</span>
        </div>
      </section>

      <section class="metric-grid metric-grid-detail">
        <article class="metric-card compact-card">
          <p>Started</p>
          <strong>{{ formatDate(inspection.run.startedAt) }}</strong>
          <span>Created {{ formatDate(inspection.run.createdAt) }}</span>
        </article>
        <article class="metric-card compact-card">
          <p>Finished</p>
          <strong>{{ formatDate(inspection.run.finishedAt) }}</strong>
          <span>Duration {{ durationLabel }}</span>
        </article>
        <article class="metric-card compact-card">
          <p>LLM usage</p>
          <strong>{{ formatNumber(inspection.usageTotals.totalTokens) }} tokens</strong>
          <span>{{ inspection.usageTotals.rounds }} provider rounds · {{ formatDuration(inspection.usageTotals.latencyMs) }}</span>
        </article>
      </section>

      <section v-if="inspection.run.error" class="panel failure-panel" role="alert">
        <p class="eyebrow" style="color:var(--danger-text)">Run failure</p>
        <h2>{{ inspection.run.error.code }}</h2>
        <p>{{ inspection.run.error.message }}</p>
      </section>

      <!-- Execution timeline -->
      <section class="panel table-panel">
        <div class="panel-heading">
          <div>
            <p class="eyebrow">Execution</p>
            <h2>Steps & timeline</h2>
            <p class="inline-note" style="margin-top:4px">Pinned to workflow version {{ inspection.version.version }} · step status is the source of truth</p>
          </div>
          <Clock3 :size="20" aria-hidden="true" />
        </div>

        <EmptyState v-if="inspection.steps.length === 0" title="No step executions yet" description="This run has not recorded a workflow step execution. Queued runs will populate once the worker claims the job." />

        <div v-else style="display:grid;gap:0">
          <div v-for="(step, idx) in inspection.steps" :key="step.id" style="display:grid;grid-template-columns:28px 1fr;gap:12px;padding:14px 0;border-top:1px solid var(--border-subtle)">
            <div style="display:grid;justify-items:center">
              <span :style="`display:grid;place-items:center;width:28px;height:28px;border-radius:999px;font-size:11px;font-weight:600;border:1px solid var(--border);background:${step.status==='succeeded' ? 'var(--success-bg)' : step.status==='failed' ? 'var(--danger-bg)' : step.status==='running' ? 'var(--info-bg)' : 'var(--neutral-bg)'};color:${step.status==='succeeded' ? 'var(--success-text)' : step.status==='failed' ? 'var(--danger-text)' : step.status==='running' ? 'var(--info-text)' : 'var(--neutral-text)'}`" aria-hidden="true">{{ step.status === 'succeeded' ? '✓' : step.status === 'failed' ? '✕' : step.status === 'running' ? '◷' : '•' }}</span>
              <span v-if="idx < inspection.steps.length - 1" style="width:1px;height:16px;background:var(--border);margin-top:6px"></span>
            </div>
            <div style="min-width:0">
              <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;justify-content:space-between">
                <strong style="font-size:13px">{{ step.stepKey }} <span style="color:var(--text-muted);font-weight:400">· {{ step.stepType }}</span></strong>
                <div style="display:flex;gap:6px;align-items:center">
                  <span class="pill" style="font-size:11px">attempt {{ step.attempt }}</span>
                  <StatusBadge :status="step.status" />
                </div>
              </div>
              <p style="margin:6px 0 0;color:var(--text-muted);font-size:12px;display:flex;gap:12px;flex-wrap:wrap">
                <span>Duration: {{ formatDuration(step.durationMs) }}</span>
                <span>Started: {{ formatDate(step.startedAt) }}</span>
                <span v-if="step.finishedAt">Finished: {{ formatDate(step.finishedAt) }}</span>
              </p>
              <p v-if="step.error" style="margin:8px 0 0;padding:10px 12px;border-radius:8px;background:var(--danger-bg);border:1px solid #f3c6c1;color:#7a271a;font-size:12px"><strong>{{ step.error.code }}:</strong> {{ step.error.message }}</p>
              <details style="margin-top:8px">
                <summary style="cursor:pointer;color:var(--text-secondary);font-size:12px;font-weight:500">Summaries (redacted)</summary>
                <div style="margin-top:8px;display:grid;gap:8px">
                  <div style="padding:10px;border:1px solid var(--border-subtle);border-radius:8px;background:var(--surface-raised)"><p style="margin:0 0 4px;color:var(--text-muted);font-size:11px;letter-spacing:0.06em;text-transform:uppercase">Input · {{ step.inputSummary.bytes }} bytes</p><p style="margin:0;font-family:var(--font-mono);font-size:12px;white-space:pre-wrap;word-break:break-word">{{ step.inputSummary.preview }}</p></div>
                  <div style="padding:10px;border:1px solid var(--border-subtle);border-radius:8px;background:var(--surface-raised)"><p style="margin:0 0 4px;color:var(--text-muted);font-size:11px;letter-spacing:0.06em;text-transform:uppercase">Output · {{ step.outputSummary.bytes }} bytes</p><p style="margin:0;font-family:var(--font-mono);font-size:12px;white-space:pre-wrap;word-break:break-word">{{ step.outputSummary.preview }}</p></div>
                </div>
              </details>
            </div>
          </div>
        </div>
      </section>

      <section class="detail-grid">
        <article class="panel table-panel">
          <div class="panel-heading"><div><p class="eyebrow">Queue</p><h2>Jobs</h2><p class="inline-note">Durable, leased, retried</p></div><Database :size="20" aria-hidden="true" /></div>
          <EmptyState v-if="inspection.jobs.length === 0" title="No jobs recorded" description="No queued work is associated with this run." />
          <div v-else style="display:grid;gap:0">
            <div v-for="job in inspection.jobs" :key="job.id" style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 0;border-top:1px solid var(--border-subtle)">
              <div style="min-width:0">
                <strong style="font-size:13px">{{ job.stepKey }}</strong>
                <p style="margin:2px 0 0;color:var(--text-muted);font-size:12px">Attempt {{ job.attempt }} · {{ job.retryCount }}/{{ job.maxAttempts }} retries · {{ formatDate(job.runAt) }}</p>
                <p v-if="job.lastError" style="margin:4px 0 0;color:var(--danger-text);font-size:12px">{{ job.lastError.code }}: {{ job.lastError.message }}</p>
              </div>
              <div style="display:flex;flex-direction:column;gap:6px;align-items:flex-end">
                <StatusBadge :status="job.status" />
                <span class="pill" style="font-size:11px">{{ job.leased ? 'Active lease' : 'No lease' }}</span>
              </div>
            </div>
          </div>
        </article>

        <article class="panel table-panel">
          <div class="panel-heading"><div><p class="eyebrow">Tool activity</p><h2>LLM tools</h2><p class="inline-note">Per-step rounds</p></div><Wrench :size="20" aria-hidden="true" /></div>
          <EmptyState v-if="inspection.tools.length === 0" title="No tool activity" description="No LLM step has used an external tool in this run." />
          <div v-else class="activity-list">
            <div v-for="tool in inspection.tools" :key="tool.stepKey" class="activity-row">
              <div><strong>{{ tool.stepKey }}</strong><p>{{ tool.rounds }} model rounds · {{ tool.usedTools ? 'tools used' : 'no tools' }}</p></div>
              <span class="activity-meta">{{ tool.usedTools ? `${tool.toolRounds} tool rounds` : "—" }}</span>
            </div>
          </div>
          <div v-if="inspection.llmUsage.length > 0" style="margin-top:14px;border-top:1px solid var(--border-subtle);padding-top:12px">
            <p style="margin:0 0 8px;color:var(--text-muted);font-size:12px;font-weight:500">LLM usage by round</p>
            <div style="display:grid;gap:8px">
              <div v-for="(u, i) in inspection.llmUsage" :key="i" style="display:flex;justify-content:space-between;gap:12px;padding:10px;border:1px solid var(--border-subtle);border-radius:8px;background:var(--surface-raised);font-size:12px">
                <span><strong>{{ u.model }}</strong> · {{ u.provider }} {{ u.stepKey ? '· ' + u.stepKey : '' }}</span>
                <span style="font-family:var(--font-mono)">{{ formatNumber(u.totalTokens) }} tok · {{ formatDuration(u.latencyMs) }}</span>
              </div>
            </div>
          </div>
        </article>
      </section>

      <section class="panel context-panel">
        <div class="panel-heading"><div><p class="eyebrow">Trigger</p><h2>{{ inspection.event.source }}</h2><p class="inline-note">Event {{ inspection.event.id.slice(0,8) }}… · {{ formatDate(inspection.event.receivedAt) }}</p></div><Bot :size="20" aria-hidden="true" /></div>
        <dl class="definition-list">
          <div><dt>Event ID</dt><dd style="font-family:var(--font-mono);font-size:12px;word-break:break-all">{{ inspection.event.id }}</dd></div>
          <div><dt>Received</dt><dd>{{ formatDate(inspection.event.receivedAt) }}</dd></div>
          <div><dt>Workflow</dt><dd>{{ inspection.workflow.name }} ({{ inspection.workflow.id.slice(0,8) }}…)</dd></div>
        </dl>
        <div style="margin-top:16px;display:grid;gap:10px">
          <div style="padding:12px;border:1px solid var(--border-subtle);border-radius:8px;background:var(--surface-raised)">
            <p style="margin:0 0 6px;color:var(--text-muted);font-size:11px;letter-spacing:0.06em;text-transform:uppercase">Payload summary · {{ inspection.event.payloadSummary.bytes }} bytes</p>
            <p style="margin:0;font-family:var(--font-mono);font-size:12px;white-space:pre-wrap;word-break:break-word">{{ inspection.event.payloadSummary.preview }}</p>
            <p v-if="inspection.event.payloadSummary.truncated" style="margin:6px 0 0;color:var(--text-muted);font-size:11px">Truncated preview — full payload redacted.</p>
          </div>
          <div style="padding:12px;border:1px solid var(--border-subtle);border-radius:8px;background:var(--surface-raised)">
            <p style="margin:0 0 6px;color:var(--text-muted);font-size:11px;letter-spacing:0.06em;text-transform:uppercase">Run context · {{ inspection.run.contextSummary.bytes }} bytes</p>
            <p style="margin:0;font-family:var(--font-mono);font-size:12px;white-space:pre-wrap;word-break:break-word">{{ inspection.run.contextSummary.preview }}</p>
          </div>
        </div>
      </section>
    </template>
  </div>
</template>
