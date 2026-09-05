<script setup lang="ts">
import { ListFilter, Search } from '@lucide/vue';
</script>

<template>
  <div>
    <PageHeader title="Runs" description="Inspect the execution history exposed by the backend." />
    <section class="panel panel-emphasis">
      <div class="panel-heading">
        <div>
          <p class="eyebrow">Run inspection</p>
          <h2>Open a specific run</h2>
        </div>
        <Search :size="20" aria-hidden="true" />
      </div>
      <p class="panel-copy">Paste a run ID to load its tenant-scoped execution details, steps, jobs, usage, and safe error information.</p>
      <RunLookup />
    </section>
    <section class="panel">
      <EmptyState title="Run list is not exposed yet" description="The backend currently provides secure inspection for a single run, not list, search, or filtering endpoints.">
        <span class="muted-inline"><ListFilter :size="16" /> Filtering arrives with the backend list API.</span>
      </EmptyState>
    </section>
  </div>
</template>
