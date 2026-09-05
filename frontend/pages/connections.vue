<script setup lang="ts">
import { Cable } from '@lucide/vue';
</script>

<template>
  <div>
    <PageHeader title="Connections" description="External provider connections available to tenant workflows." />
    <section class="panel">
      <EmptyState title="Connection management is currently handled through the backend/CLI." description="Connection credentials remain encrypted and are never available to this application. A safe connection-list endpoint has not been added yet." />
    </section>
    <section class="callout-row">
      <Cable :size="18" aria-hidden="true" />
      <p>This frontend does not attempt to read, display, or manage credentials, API keys, or provider tokens.</p>
    </section>
  </div>
</template>
