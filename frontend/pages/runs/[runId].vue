<script setup lang="ts">
import { ArrowLeft, Bot, Clock3, Database, Wrench, Workflow, Sparkles, Activity, Shield } from '@lucide/vue';
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
const statusTone = computed(() => inspection.value?.run.status ?? 'queued');
</script>

<template>
  <div>
    <PageHeader title="Execution inspector" eyebrow="Run detail" description="A premium view of one run — workflow, trigger, steps, jobs and tool activity, all redacted and tenant-scoped.">
      <template #actions>
        <NuxtLink class="button button-secondary" to="/runs" style="border-radius:999px">
          <ArrowLeft :size="16" aria-hidden="true" />
          Runs
        </NuxtLink>
      </template>
    </PageHeader>

    <LoadingState v-if="pending" />
    <ErrorState v-else-if="error" :message="error" @retry="refresh" />

    <template v-else-if="inspection">
      <!-- Run hero — large bento -->
      <div class="workspace-bento" style="margin-bottom:20px">
        <section class="panel" style="grid-column:span 4; padding:20px; position:relative; overflow:hidden">
          <div aria-hidden="true" style="position:absolute; inset:0; background:radial-gradient(520px 220px at 85% 10%, rgba(183,164,251,0.08), transparent 60%), radial-gradient(380px 200px at 10% 90%, rgba(139,245,201,0.06), transparent 60%); pointer-events:none" />
          <div style="position:relative">
            <div style="display:flex; align-items:center; gap:8px; margin-bottom:10px">
              <span style="display:inline-flex; align-items:center; gap:6px; padding:6px 10px; border-radius:999px; background:rgba(183,164,251,0.12); border:1px solid rgba(183,164,251,0.22); color:var(--landing-lilac); font-size:11px; font-weight:600; letter-spacing:0.06em; text-transform:uppercase"><Workflow :size="12" aria-hidden="true" />{{ inspection.workflow.name }} · v{{ inspection.version.version }}</span>
              <span class="pill" style="border-radius:999px; font-size:11px">{{ inspection.version.triggerType }} trigger</span>
            </div>
            <h2 style="margin:0; font-family:var(--font-mono); font-size:15px; color:var(--landing-mist); word-break:break-all; display:flex; align-items:center; gap:10px; letter-spacing:-0.02em">
              {{ inspection.run.id }}
              <span class="status-dot" :class="statusTone==='succeeded' ? 'status-dot--success' : statusTone==='failed' ? 'status-dot--failed' : 'status-dot--running'" aria-hidden="true" />
            </h2>
            <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:12px">
              <StatusBadge :status="inspection.run.status" />
              <span class="pill" style="border-radius:999px">{{ durationLabel }}</span>
              <span class="pill" style="border-radius:999px; font-family:var(--font-mono); font-size:11px">{{ inspection.run.currentStepKey ? 'Current: ' + inspection.run.currentStepKey : 'Complete' }}</span>
              <span class="pill" style="border-radius:999px; font-size:11px">{{ inspection.workflow.status }}</span>
            </div>
            <div style="margin-top:14px; display:flex; gap:8px; flex-wrap:wrap; font-size:11px; color:var(--landing-faint)">
              <span style="display:inline-flex; gap:6px; align-items:center"><Shield :size="12" aria-hidden="true" style="color:var(--landing-mint)" /> Tenant-scoped</span>
              <span>·</span>
              <span>Pinned to version {{ inspection.version.version }}</span>
            </div>
          </div>
        </section>

        <div style="grid-column:span 2; display:grid; gap:14px">
          <article class="metric-card card-sheen" style="min-height:96px; padding:16px 18px; display:flex; align-items:center; gap:12px; margin:0">
            <span style="display:grid;place-items:center;width:36px;height:36px;border-radius:10px;background:rgba(183,164,251,0.12);border:1px solid rgba(183,164,251,0.22);color:var(--landing-lilac)"><Clock3 :size="16" aria-hidden="true" /></span>
            <div>
              <p style="margin:0;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;font-weight:600">Duration</p>
              <strong style="font-size:18px;margin:2px 0 0">{{ durationLabel }}</strong>
              <span style="font-size:11px">Started {{ formatDate(inspection.run.startedAt) }}</span>
            </div>
          </article>
          <article class="metric-card card-sheen" style="min-height:96px; padding:16px 18px; display:flex; align-items:center; gap:12px; margin:0">
            <span style="display:grid;place-items:center;width:36px;height:36px;border-radius:10px;background:rgba(139,245,201,0.12);border:1px solid rgba(139,245,201,0.22);color:var(--landing-mint)"><Sparkles :size="16" aria-hidden="true" /></span>
            <div>
              <p style="margin:0;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;font-weight:600">LLM</p>
              <strong style="font-size:18px;margin:2px 0 0">{{ formatNumber(inspection.usageTotals.totalTokens) }} tokens</strong>
              <span style="font-size:11px">{{ inspection.usageTotals.rounds }} rounds · {{ formatDuration(inspection.usageTotals.latencyMs) }}</span>
            </div>
          </article>
        </div>
      </div>

      <section v-if="inspection.run.error" class="panel failure-panel" role="alert" style="border-radius:16px">
        <p style="margin:0 0 6px; font-size:11px; letter-spacing:0.14em; text-transform:uppercase; color:#ff9a9a; font-weight:600">Run failure</p>
        <h2 style="margin:0; color:#ff9a9a">{{ inspection.run.error.code }}</h2>
        <p style="margin:8px 0 0; color:#ffb4b4">{{ inspection.run.error.message }}</p>
      </section>

      <!-- Execution — dominant central structure -->
      <section class="panel" style="padding:0; overflow:hidden">
        <div style="padding:18px 20px; display:flex; align-items:center; justify-content:space-between; border-bottom:1px solid var(--landing-border)">
          <div>
            <p style="margin:0; font-size:11px; letter-spacing:0.14em; text-transform:uppercase; color:var(--landing-faint); font-weight:600">Execution</p>
            <h2 style="margin:4px 0 0; font-size:16px; color:var(--landing-mist); letter-spacing:-0.02em">Steps & timeline</h2>
            <p style="margin:4px 0 0; font-size:11px; color:var(--landing-faint)">Pinned to workflow version {{ inspection.version.version }} · step status is the source of truth</p>
          </div>
          <span style="display:grid;place-items:center;width:36px;height:36px;border-radius:10px;background:rgba(139,245,201,0.12);border:1px solid rgba(139,245,201,0.22);color:var(--landing-mint)"><Activity :size="16" aria-hidden="true" /></span>
        </div>

        <div style="padding:0 20px">
          <EmptyState v-if="inspection.steps.length === 0" title="No step executions yet" description="This run has not recorded a workflow step execution. Queued runs will populate once the worker claims the job." />

          <div v-else style="position:relative; padding:8px 0">
            <!-- vertical line glow behind dots -->
            <div aria-hidden="true" style="position:absolute; left:35px; top:24px; bottom:24px; width:1px; background:linear-gradient(180deg, rgba(139,245,201,0.18), rgba(183,164,251,0.18), rgba(255,255,255,0.06))" />
            <div v-for="(step, idx) in inspection.steps" :key="step.id" style="display:grid; grid-template-columns:40px 1fr; gap:14px; padding:18px 0; border-top:1px solid var(--landing-border); position:relative">
              <div v-if="idx===0" style="position:absolute; top:0; left:0; right:0; height:1px; background:var(--landing-border); display:none" aria-hidden="true" />
              <div style="display:grid; justify-items:center; gap:6px; position:relative">
                <span class="timeline-dot" :class="step.status==='succeeded' ? 'timeline-dot--success' : step.status==='failed' ? 'timeline-dot--failed' : step.status==='running' ? 'timeline-dot--running' : 'timeline-dot--queued'" aria-hidden="true" style="width:32px;height:32px; display:grid; place-items:center; border-radius:999px; font-size:11px; z-index:1">{{ step.status === 'succeeded' ? '✓' : step.status === 'failed' ? '✕' : step.status === 'running' ? '◷' : '•' }}</span>
                <span v-if="step.status==='running'" style="width:6px;height:6px;border-radius:999px;background:var(--landing-lilac);box-shadow:0 0 0 6px rgba(183,164,251,0.12); animation:pulse-dot 2s infinite" aria-hidden="true" />
              </div>
              <div style="min-width:0">
                <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center; justify-content:space-between">
                  <strong style="font-size:13px; color:var(--landing-mist)">{{ step.stepKey }} <span style="color:var(--landing-faint);font-weight:400">· {{ step.stepType }}</span></strong>
                  <div style="display:flex; gap:6px; align-items:center">
                    <span class="pill" style="font-size:11px;border-radius:999px">attempt {{ step.attempt }}</span>
                    <StatusBadge :status="step.status" />
                  </div>
                </div>
                <p style="margin:6px 0 0;color:var(--landing-faint);font-size:11px;display:flex;gap:12px;flex-wrap:wrap">
                  <span>Duration: {{ formatDuration(step.durationMs) }}</span>
                  <span>Started: {{ formatDate(step.startedAt) }}</span>
                  <span v-if="step.finishedAt">Finished: {{ formatDate(step.finishedAt) }}</span>
                </p>
                <p v-if="step.error" style="margin:10px 0 0;padding:10px 12px;border-radius:10px;background:rgba(42,16,16,0.7);border:1px solid rgba(255,107,107,0.22);color:#ffb4b4;font-size:12px"><strong style="color:#ff9a9a">{{ step.error.code }}:</strong> {{ step.error.message }}</p>
                <details style="margin-top:12px">
                  <summary style="cursor:pointer;color:var(--landing-dim);font-size:11px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;display:inline-flex;gap:6px;align-items:center">Summaries (redacted) <span style="font-size:10px">▾</span></summary>
                  <div style="margin-top:10px;display:grid;gap:8px">
                    <div style="padding:12px;border:1px solid var(--landing-border);border-radius:12px;background:rgba(255,255,255,0.04)"><p style="margin:0 0 6px;color:var(--landing-faint);font-size:10px;letter-spacing:0.08em;text-transform:uppercase">Input · {{ step.inputSummary.bytes }} bytes</p><p style="margin:0;font-family:var(--font-mono);font-size:11px;white-space:pre-wrap;word-break:break-word;color:var(--landing-dim)">{{ step.inputSummary.preview }}</p></div>
                    <div style="padding:12px;border:1px solid var(--landing-border);border-radius:12px;background:rgba(255,255,255,0.04)"><p style="margin:0 0 6px;color:var(--landing-faint);font-size:10px;letter-spacing:0.08em;text-transform:uppercase">Output · {{ step.outputSummary.bytes }} bytes</p><p style="margin:0;font-family:var(--font-mono);font-size:11px;white-space:pre-wrap;word-break:break-word;color:var(--landing-dim)">{{ step.outputSummary.preview }}</p></div>
                  </div>
                </details>
              </div>
            </div>
          </div>
        </div>
      </section>

      <div class="workspace-bento" style="margin-top:16px">
        <article class="panel card-sheen" style="grid-column:span 3; padding:0; overflow:hidden">
          <div style="padding:14px 18px; display:flex; align-items:center; justify-content:space-between; border-bottom:1px solid var(--landing-border)">
            <div>
              <p style="margin:0;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:var(--landing-faint);font-weight:600">Queue</p>
              <h2 style="margin:2px 0 0;font-size:14px;color:var(--landing-mist)">Jobs</h2>
            </div>
            <Database :size="16" aria-hidden="true" style="color:var(--landing-faint)" />
          </div>
          <div style="padding:0 18px">
            <EmptyState v-if="inspection.jobs.length === 0" title="No jobs recorded" description="No queued work is associated with this run." />
            <div v-else style="display:grid">
              <div v-for="job in inspection.jobs" :key="job.id" style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 0;border-top:1px solid var(--landing-border)">
                <div style="min-width:0">
                  <strong style="font-size:13px;color:var(--landing-mist)">{{ job.stepKey }}</strong>
                  <p style="margin:2px 0 0;color:var(--landing-faint);font-size:11px">Attempt {{ job.attempt }} · {{ job.retryCount }}/{{ job.maxAttempts }} retries · {{ formatDate(job.runAt) }}</p>
                  <p v-if="job.lastError" style="margin:4px 0 0;color:#ff9a9a;font-size:11px">{{ job.lastError.code }}: {{ job.lastError.message }}</p>
                </div>
                <div style="display:flex;flex-direction:column;gap:6px;align-items:flex-end">
                  <StatusBadge :status="job.status" />
                  <span class="pill" style="font-size:11px;border-radius:999px">{{ job.leased ? 'Active lease' : 'No lease' }}</span>
                </div>
              </div>
            </div>
          </div>
        </article>

        <article class="panel card-sheen" style="grid-column:span 3; padding:0; overflow:hidden">
          <div style="padding:14px 18px; display:flex; align-items:center; justify-content:space-between; border-bottom:1px solid var(--landing-border)">
            <div>
              <p style="margin:0;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:var(--landing-faint);font-weight:600">Tool activity</p>
              <h2 style="margin:2px 0 0;font-size:14px;color:var(--landing-mist)">LLM tools</h2>
            </div>
            <Wrench :size="16" aria-hidden="true" style="color:var(--landing-faint)" />
          </div>
          <div style="padding:0 18px">
            <EmptyState v-if="inspection.tools.length === 0" title="No tool activity" description="No LLM step has used an external tool in this run." />
            <div v-else style="display:grid">
              <div v-for="tool in inspection.tools" :key="tool.stepKey" style="display:flex; align-items:center; justify-content:space-between; gap:12px; padding:12px 0; border-top:1px solid var(--landing-border)">
                <div><strong style="font-size:13px;color:var(--landing-mist)">{{ tool.stepKey }}</strong><p style="margin:2px 0 0;color:var(--landing-faint);font-size:11px">{{ tool.rounds }} model rounds · {{ tool.usedTools ? 'tools used' : 'no tools' }}</p></div>
                <span style="font-size:11px;color:var(--landing-faint);font-family:var(--font-mono)">{{ tool.usedTools ? `${tool.toolRounds} tool rounds` : "—" }}</span>
              </div>
            </div>
            <div v-if="inspection.llmUsage.length > 0" style="margin:12px 0 16px; border-top:1px solid var(--landing-border); padding-top:12px">
              <p style="margin:0 0 8px;color:var(--landing-faint);font-size:10px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase">LLM usage by round</p>
              <div style="display:grid;gap:8px">
                <div v-for="(u, i) in inspection.llmUsage" :key="i" style="display:flex;justify-content:space-between;gap:12px;padding:10px 12px;border:1px solid var(--landing-border);border-radius:10px;background:rgba(255,255,255,0.04);font-size:11px">
                  <span style="color:var(--landing-mist)"><strong>{{ u.model }}</strong> · {{ u.provider }} {{ u.stepKey ? '· ' + u.stepKey : '' }}</span>
                  <span style="font-family:var(--font-mono);color:var(--landing-dim)">{{ formatNumber(u.totalTokens) }} tok · {{ formatDuration(u.latencyMs) }}</span>
                </div>
              </div>
            </div>
          </div>
        </article>
      </div>

      <section class="panel" style="margin-top:16px; padding:0; overflow:hidden">
        <div style="padding:14px 18px; display:flex; align-items:center; justify-content:space-between; border-bottom:1px solid var(--landing-border)">
          <div>
            <p style="margin:0;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:var(--landing-faint);font-weight:600">Trigger</p>
            <h2 style="margin:2px 0 0;font-size:14px;color:var(--landing-mist)">{{ inspection.event.source }}</h2>
            <p style="margin:4px 0 0;font-size:11px;color:var(--landing-faint)">Event {{ inspection.event.id.slice(0,8) }}… · {{ formatDate(inspection.event.receivedAt) }}</p>
          </div>
          <Bot :size="16" aria-hidden="true" style="color:var(--landing-faint)" />
        </div>
        <div style="padding:16px 18px">
          <dl style="display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:16px; margin:0">
            <div><dt style="font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:var(--landing-faint);font-weight:600">Event ID</dt><dd style="margin:4px 0 0;font-family:var(--font-mono);font-size:11px;word-break:break-all;color:var(--landing-dim)">{{ inspection.event.id }}</dd></div>
            <div><dt style="font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:var(--landing-faint);font-weight:600">Received</dt><dd style="margin:4px 0 0;font-size:11px;color:var(--landing-dim)">{{ formatDate(inspection.event.receivedAt) }}</dd></div>
            <div><dt style="font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:var(--landing-faint);font-weight:600">Workflow</dt><dd style="margin:4px 0 0;font-size:11px;color:var(--landing-dim)">{{ inspection.workflow.name }} ({{ inspection.workflow.id.slice(0,8) }}…)</dd></div>
          </dl>
          <div style="margin-top:16px;display:grid;gap:10px">
            <div style="padding:12px;border:1px solid var(--landing-border);border-radius:12px;background:rgba(255,255,255,0.04)">
              <p style="margin:0 0 6px;color:var(--landing-faint);font-size:10px;letter-spacing:0.08em;text-transform:uppercase">Payload summary · {{ inspection.event.payloadSummary.bytes }} bytes</p>
              <p style="margin:0;font-family:var(--font-mono);font-size:11px;white-space:pre-wrap;word-break:break-word;color:var(--landing-dim)">{{ inspection.event.payloadSummary.preview }}</p>
              <p v-if="inspection.event.payloadSummary.truncated" style="margin:6px 0 0;color:var(--landing-faint);font-size:11px">Truncated preview — full payload redacted.</p>
            </div>
            <div style="padding:12px;border:1px solid var(--landing-border);border-radius:12px;background:rgba(255,255,255,0.04)">
              <p style="margin:0 0 6px;color:var(--landing-faint);font-size:10px;letter-spacing:0.08em;text-transform:uppercase">Run context · {{ inspection.run.contextSummary.bytes }} bytes</p>
              <p style="margin:0;font-family:var(--font-mono);font-size:11px;white-space:pre-wrap;word-break:break-word;color:var(--landing-dim)">{{ inspection.run.contextSummary.preview }}</p>
            </div>
          </div>
        </div>
      </section>
    </template>
  </div>
</template>
