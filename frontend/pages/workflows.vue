<script setup lang="ts">
import { Workflow } from '@lucide/vue';
</script>

<template>
  <div>
    <PageHeader title="Workflows" description="Versioned workflow definitions owned by your tenant." />
    <section class="panel">
      <EmptyState title="Workflow list is not exposed yet" description="The backend supports workflow versions and execution, but it has no authenticated workflow-list route at this point." />
    </section>
    <section class="callout-row">
      <Workflow :size="18" aria-hidden="true" />
      <p>This interface is deliberately read-only for this milestone. Workflow editing and visual construction are deferred.</p>
    </section>
  </div>
</template>
