<script setup lang="ts">
import { Activity, ListFilter, PlaySquare, Sparkles, Clock3, AlertCircle } from "@lucide/vue";
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
const succeeded = computed(() => items.value.filter(r => r.status === 'succeeded').length);
const active = computed(() => items.value.filter(r => ['running','queued','waiting'].includes(r.status)).length);
const failed = computed(() => items.value.filter(r => r.status === 'failed').length);

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
      title="Execution activity"
      eyebrow="Runs"
      description="Inspect what your workforce is doing — what ran, what is running, what failed, and how long it took."
    />

    <div class="workspace-bento" style="margin-bottom:20px">
      <section class="panel" style="grid-column:span 4; padding:0; overflow:hidden; display:flex; flex-direction:column">
        <div style="padding:16px 20px; display:flex; align-items:center; justify-content:space-between; border-bottom:1px solid var(--landing-border)">
          <div style="display:flex; gap:10px; align-items:center">
            <span style="display:grid;place-items:center;width:28px;height:28px;border-radius:8px;background:rgba(183,164,251,0.12);border:1px solid rgba(183,164,251,0.22);color:var(--landing-lilac)"><Activity :size="14" aria-hidden="true" /></span>
            <div>
              <p style="margin:0;font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:var(--landing-faint);font-weight:600">Command center</p>
              <h2 style="margin:0;font-size:14px;color:var(--landing-mist)">Live execution feed</h2>
            </div>
          </div>
          <span class="pill" style="border-radius:999px; background:rgba(255,255,255,0.06)">{{ items.length }} visible · page {{ previousCursors.length + 1 }}</span>
        </div>
        <div style="padding:14px 20px; display:flex; gap:16px; flex-wrap:wrap; border-bottom:1px solid var(--landing-border); background:rgba(255,255,255,0.02)">
          <span style="display:inline-flex; gap:8px; align-items:center; font-size:12px; color:var(--landing-dim)"><span class="status-dot status-dot--success" aria-hidden="true" />{{ succeeded }} succeeded</span>
          <span style="display:inline-flex; gap:8px; align-items:center; font-size:12px; color:var(--landing-dim)"><span class="status-dot status-dot--running" aria-hidden="true" />{{ active }} active</span>
          <span style="display:inline-flex; gap:8px; align-items:center; font-size:12px; color:#ff9a9a"><span class="status-dot status-dot--failed" aria-hidden="true" />{{ failed }} failed</span>
        </div>
        <div style="padding:10px 20px; display:flex; gap:8px; align-items:center; font-size:11px; color:var(--landing-faint)">
          <Clock3 :size="12" aria-hidden="true" style="color:var(--landing-lilac)" />
          <span>Tenant-scoped · cursor pagination · filters are URL-synced</span>
        </div>
      </section>

      <div style="grid-column:span 2; display:grid; gap:14px">
        <article class="metric-card card-sheen" style="min-height:96px; padding:16px 18px; display:flex; align-items:center; gap:12px; margin:0">
          <span style="display:grid;place-items:center;width:36px;height:36px;border-radius:10px;background:rgba(139,245,201,0.12);border:1px solid rgba(139,245,201,0.22);color:var(--landing-mint)"><PlaySquare :size="16" aria-hidden="true" /></span>
          <div>
            <p style="margin:0;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;font-weight:600">Succeeded</p>
            <strong style="font-size:22px;margin:2px 0 0;color:var(--landing-mint)">{{ succeeded }}</strong>
            <span style="font-size:11px">calm & complete</span>
          </div>
        </article>
        <article class="metric-card card-sheen" style="min-height:96px; padding:16px 18px; display:flex; align-items:center; gap:12px; margin:0">
          <span style="display:grid;place-items:center;width:36px;height:36px;border-radius:10px;background:rgba(255,107,107,0.12);border:1px solid rgba(255,107,107,0.22);color:#ff8a8a"><AlertCircle :size="16" aria-hidden="true" /></span>
          <div>
            <p style="margin:0;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;font-weight:600">Failed</p>
            <strong style="font-size:22px;margin:2px 0 0;color:#ff8a8a">{{ failed }}</strong>
            <span style="font-size:11px">needs attention</span>
          </div>
        </article>
      </div>
    </div>

    <section class="panel" style="padding:0; overflow:hidden">
      <div style="padding:14px 20px; border-bottom:1px solid var(--landing-border)">
        <form style="display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; padding:12px; border-radius:14px; border:1px solid var(--landing-border); background:rgba(255,255,255,0.04); backdrop-filter:blur(8px)" @submit.prevent="applyFilters" aria-label="Run filters">
          <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap">
            <label for="run-status" style="font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:var(--landing-faint);font-weight:600">Status</label>
            <select id="run-status" v-model="status" class="filter-select" aria-label="Filter by status" style="border-radius:999px; min-width:140px; background:rgba(255,255,255,0.06)">
              <option value="">All statuses</option>
              <option value="queued">Queued</option>
              <option value="running">Running</option>
              <option value="waiting">Waiting</option>
              <option value="succeeded">Succeeded</option>
              <option value="failed">Failed</option>
              <option value="cancelled">Cancelled</option>
            </select>

            <label for="workflow-filter" style="font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:var(--landing-faint);font-weight:600">Workflow</label>
            <select id="workflow-filter" v-model="workflowId" class="filter-select" aria-label="Filter by workflow" style="border-radius:999px; min-width:160px; background:rgba(255,255,255,0.06)">
              <option value="">All workflows</option>
              <option v-for="workflow in workflows?.items ?? []" :key="workflow.id" :value="workflow.id">{{ workflow.name }}</option>
            </select>
          </div>
          <div style="display:flex; gap:8px">
            <button class="button button-primary" type="submit" style="border-radius:999px; height:36px">
              <ListFilter :size="14" aria-hidden="true" />
              Apply
            </button>
            <button v-if="status || workflowId" class="button button-secondary" type="button" @click="clearFilters" style="border-radius:999px">Clear</button>
          </div>
        </form>
      </div>

      <div style="padding:16px">
        <LoadingState v-if="pending" />
        <ErrorState v-else-if="error" :message="error" @retry="refresh" />
        <EmptyState
          v-else-if="items.length === 0"
          title="No runs match this view"
          description="Trigger a workflow via webhook or clear filters to see available runs."
        />

        <template v-else>
          <!-- Premium feed — not a plain table -->
          <div style="display:grid; gap:10px">
            <NuxtLink
              v-for="run in items"
              :key="run.id"
              :to="`/runs/${encodeURIComponent(run.id)}`"
              class="run-feed-item"
              :class="{
                'run-feed-item--succeeded': run.status === 'succeeded',
                'run-feed-item--failed': run.status === 'failed',
                'run-feed-item--running': ['running','queued','waiting'].includes(run.status)
              }"
              style="text-decoration:none"
            >
              <div style="display:grid; place-items:center; width:40px; height:40px; border-radius:12px; background:rgba(255,255,255,0.06); border:1px solid var(--landing-border); color:var(--landing-mist); position:relative">
                <span class="status-dot" :class="run.status==='succeeded' ? 'status-dot--success' : run.status==='failed' ? 'status-dot--failed' : 'status-dot--running'" style="position:absolute; top:-4px; right:-4px; width:10px; height:10px; border:2px solid var(--landing-panel)" aria-hidden="true" />
                <PlaySquare :size="16" aria-hidden="true" />
              </div>
              <div style="min-width:0">
                <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap">
                  <strong style="font-size:13px; color:var(--landing-mist)">{{ run.workflowName }}</strong>
                  <StatusBadge :status="run.status" />
                  <span class="pill" style="border-radius:999px; font-family:var(--font-mono); font-size:11px">{{ run.currentStepKey ?? "Complete" }}</span>
                </div>
                <p style="margin:4px 0 0; font-size:11px; color:var(--landing-faint); font-family:var(--font-mono); overflow:hidden; text-overflow:ellipsis; white-space:nowrap" :title="run.id">{{ run.id.slice(0,8) }}…{{ run.id.slice(-4) }} · {{ run.workflowId.slice(0,8) }}…</p>
                <p style="margin:4px 0 0; font-size:11px; color:var(--landing-faint); display:flex; gap:12px; flex-wrap:wrap">
                  <span>Started {{ formatDate(run.startedAt ?? run.createdAt) }}</span>
                  <span v-if="run.finishedAt">· Finished {{ formatDate(run.finishedAt) }}</span>
                </p>
              </div>
              <div style="display:flex; flex-direction:column; gap:6px; align-items:flex-end; flex:0 0 auto">
                <span style="font-size:11px; color:var(--landing-faint); font-family:var(--font-mono)">{{ run.id.slice(0,8) }}…</span>
                <span style="font-size:11px; color:var(--landing-dim); display:inline-flex; gap:6px; align-items:center"><Sparkles :size="12" aria-hidden="true" style="color:var(--landing-lilac)" /> Inspect →</span>
              </div>
            </NuxtLink>
          </div>
        </template>

        <div v-if="items.length > 0" style="display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; margin-top:16px; padding-top:14px; border-top:1px solid var(--landing-border)">
          <p style="margin:0; font-size:11px; color:var(--landing-faint)">Cursor pagination · tenant-scoped</p>
          <div style="display:flex; gap:8px">
            <button class="button button-secondary" type="button" :disabled="!hasPrevious" @click="loadPrevious" style="border-radius:999px">Previous</button>
            <button class="button button-secondary" type="button" :disabled="!hasNext" @click="loadNext" style="border-radius:999px">Next</button>
          </div>
        </div>
      </div>
    </section>

    <section class="panel" style="margin-top:16px">
      <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:14px">
        <div>
          <p style="margin:0; font-size:11px; letter-spacing:0.14em; text-transform:uppercase; color:var(--landing-faint); font-weight:600">Run lookup</p>
          <h2 style="margin:4px 0 0; font-size:14px; color:var(--landing-mist)">Open a specific run</h2>
        </div>
        <span class="pill" style="border-radius:999px">inspect</span>
      </div>
      <p style="margin:0; font-size:12px; color:var(--landing-dim); line-height:1.6">Enter a run ID to view its execution — steps, jobs, LLM usage and tool activity.</p>
      <div style="margin-top:12px">
        <RunLookup />
      </div>
    </section>
  </div>
</template>

<style scoped>
.visually-hidden { position:absolute; left:-9999px; }
</style>
