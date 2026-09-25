<script setup lang="ts">
import { ArrowRight, Layers, RefreshCw, Workflow, Sparkles, Zap } from "@lucide/vue";
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
const activeCount = computed(() => items.value.filter(w => w.status === 'active').length);
const draftCount = computed(() => items.value.filter(w => w.status !== 'active').length);

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
      title="Your AI workforce"
      eyebrow="Workflows"
      description="Manage the workflows that execute operational work — versioned, pinned, and inspectable."
    >
      <template #actions>
        <button class="button button-secondary" type="button" @click="refresh" aria-label="Refresh workflows" style="border-radius:999px">
          <RefreshCw :size="15" aria-hidden="true" />
          Refresh
        </button>
      </template>
    </PageHeader>

    <!-- Bento: large catalog surface + side metrics -->
    <div class="workspace-bento" style="margin-bottom:20px">
      <section class="panel" style="grid-column:span 4; padding:0; overflow:hidden">
        <div style="padding:18px 20px; display:flex; align-items:center; justify-content:space-between; gap:12px; border-bottom:1px solid var(--landing-border)">
          <div style="display:flex; align-items:center; gap:10px">
            <span style="display:grid;place-items:center;width:28px;height:28px;border-radius:8px;background:rgba(183,164,251,0.12);border:1px solid rgba(183,164,251,0.22);color:var(--landing-lilac)"><Layers :size="14" aria-hidden="true" /></span>
            <div>
              <p style="margin:0;font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:var(--landing-faint);font-weight:600">Catalog</p>
              <h2 style="margin:0;font-size:14px;color:var(--landing-mist)">{{ totalLabel }}</h2>
            </div>
          </div>
          <span class="pill" style="border-radius:999px;background:rgba(255,255,255,0.06)">{{ items.length }} items · keyset</span>
        </div>
        <div style="padding:16px 20px; display:flex; align-items:center; gap:8px; flex-wrap:wrap; border-bottom:1px solid var(--landing-border); background:rgba(255,255,255,0.02)">
          <span style="font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:var(--landing-faint);font-weight:600">Live</span>
          <span class="status-dot status-dot--success" aria-hidden="true" />
          <span style="font-size:12px;color:var(--landing-dim)">{{ activeCount }} active</span>
          <span style="opacity:0.3" aria-hidden="true">·</span>
          <span style="font-size:12px;color:var(--landing-dim)">{{ draftCount }} draft</span>
          <span style="margin-left:auto;font-size:11px;color:var(--landing-faint)">page {{ previousCursors.length + 1 }}</span>
        </div>
        <div style="padding:12px 20px; font-size:11px; color:var(--landing-faint); display:flex; gap:8px; align-items:center">
          <Zap :size="12" aria-hidden="true" style="color:var(--landing-lilac)" />
          <span>Tenant-scoped · linear steps · unique keys · active version pinned for in-flight runs</span>
        </div>
      </section>

      <div style="grid-column:span 2; display:grid; gap:14px">
        <article class="metric-card card-sheen" style="min-height:96px; padding:16px 18px; display:flex; align-items:center; gap:12px; margin:0">
          <span style="display:grid;place-items:center;width:36px;height:36px;border-radius:10px;background:rgba(139,245,201,0.12);border:1px solid rgba(139,245,201,0.22);color:var(--landing-mint)"><Sparkles :size="16" aria-hidden="true" /></span>
          <div>
            <p style="margin:0;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;font-weight:600">Active</p>
            <strong style="font-size:22px;margin:2px 0 0;color:var(--landing-mint)">{{ activeCount }}</strong>
            <span style="font-size:11px">ready to trigger</span>
          </div>
        </article>
        <article class="metric-card card-sheen" style="min-height:96px; padding:16px 18px; display:flex; align-items:center; gap:12px; margin:0">
          <span style="display:grid;place-items:center;width:36px;height:36px;border-radius:10px;background:rgba(255,255,255,0.06);border:1px solid var(--landing-border);color:var(--landing-faint)"><Workflow :size="16" aria-hidden="true" /></span>
          <div>
            <p style="margin:0;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;font-weight:600">Draft</p>
            <strong style="font-size:22px;margin:2px 0 0">{{ draftCount }}</strong>
            <span style="font-size:11px">awaiting activation</span>
          </div>
        </article>
      </div>
    </div>

    <section class="panel" style="padding:0; overflow:hidden">
      <div style="padding:18px 20px; display:flex; align-items:center; justify-content:space-between; border-bottom:1px solid var(--landing-border)">
        <div>
          <h2 style="margin:0;font-size:14px;color:var(--landing-mist)">Workflow catalog</h2>
          <p style="margin:4px 0 0;font-size:12px;color:var(--landing-faint)">Every workflow is a premium surface — name, status, version, trigger, and runs.</p>
        </div>
      </div>

      <div style="padding:16px">
        <LoadingState v-if="pending" />
        <ErrorState v-else-if="error" :message="error" @retry="refresh" />
        <EmptyState
          v-else-if="items.length === 0"
          title="No workflows yet"
          description="Workflows define the operations AI Workforce can execute — from webhook-triggered triage to AI-enriched jobs."
          hint="Create one via: pnpm workflow:create <tenantId> &quot;name&quot; [source]"
        />

        <template v-else>
          <!-- Premium workflow cards — hybrid layout -->
          <div style="display:grid; grid-template-columns:repeat(auto-fill,minmax(320px,1fr)); gap:14px">
            <article
              v-for="workflow in items"
              :key="workflow.id"
              class="workflow-card"
              :class="{ 'workflow-card--active': workflow.status === 'active' }"
            >
              <div style="display:flex; align-items:start; justify-content:space-between; gap:12px">
                <div style="display:flex; gap:10px; align-items:center; min-width:0">
                  <span style="display:grid;place-items:center;width:32px;height:32px;border-radius:10px;background:rgba(255,255,255,0.06);border:1px solid var(--landing-border);color:var(--landing-mist); flex:0 0 auto"><Workflow :size="16" aria-hidden="true" /></span>
                  <div style="min-width:0">
                    <h3 style="margin:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis">{{ workflow.name }}</h3>
                    <p class="mono-text" style="margin:2px 0 0; font-size:11px; color:var(--landing-faint); overflow:hidden; text-overflow:ellipsis" :title="workflow.id">{{ workflow.id.slice(0,8) }}…{{ workflow.id.slice(-4) }}</p>
                  </div>
                </div>
                <span style="display:inline-flex; gap:6px; align-items:center; flex:0 0 auto">
                  <span class="status-dot" :class="workflow.status === 'active' ? 'status-dot--success' : 'status-dot--queued'" aria-hidden="true" />
                  <StatusBadge :status="workflow.status" />
                </span>
              </div>

              <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:14px">
                <span class="pill" style="border-radius:999px; font-family:var(--font-mono); font-size:11px">v{{ workflow.activeVersion?.version ?? "—" }}</span>
                <span class="pill" style="border-radius:999px; text-transform:capitalize; font-size:11px">{{ workflow.activeVersion?.triggerType ?? "Not active" }}</span>
                <span class="pill" style="border-radius:999px; font-size:11px">{{ formatDate(workflow.updatedAt) }}</span>
              </div>

              <!-- illustrative sequence — not invented steps, generic flow -->
              <div class="workflow-visual-seq" aria-hidden="true">
                <span>webhook</span><i aria-hidden="true" /><span>steps</span><i aria-hidden="true" /><span>run</span>
                <span style="margin-left:auto; font-size:10px; color:var(--landing-faint); border:0; background:transparent; padding:0">illustrative</span>
              </div>

              <div style="display:flex; align-items:center; justify-content:space-between; gap:12px; margin-top:14px; padding-top:12px; border-top:1px solid var(--landing-border)">
                <span style="font-size:11px; color:var(--landing-faint); font-family:var(--font-mono)">{{ workflow.id.slice(0,8) }}…</span>
                <NuxtLink class="text-link" :to="`/runs?workflowId=${encodeURIComponent(workflow.id)}`" style="font-size:12px">View runs <ArrowRight :size="14" aria-hidden="true" /></NuxtLink>
              </div>
            </article>
          </div>

          <!-- Mobile fallback already handled by grid; card-list not needed separately -->
        </template>

        <div v-if="items.length > 0" style="display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; margin-top:16px; padding-top:14px; border-top:1px solid var(--landing-border)">
          <p style="margin:0; font-size:11px; color:var(--landing-faint)">Keyset pagination · cursor-based · tenant-isolated</p>
          <div style="display:flex; gap:8px">
            <button class="button button-secondary" type="button" :disabled="!hasPrevious" @click="loadPrevious" style="border-radius:999px">Previous</button>
            <button class="button button-secondary" type="button" :disabled="!hasNext" @click="loadNext" style="border-radius:999px">Next</button>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.visually-hidden { position:absolute; left:-9999px; }
</style>
