<script setup lang="ts">
import { ArrowRight, Search } from '@lucide/vue';
import { ref } from 'vue';

const runId = ref('');
const router = useRouter();

async function openRun(): Promise<void> {
  const trimmed = runId.value.trim();
  if (trimmed !== '') await router.push(`/runs/${encodeURIComponent(trimmed)}`);
}
</script>

<template>
  <form class="run-lookup" @submit.prevent="openRun">
    <label for="run-id">Inspect a run</label>
    <div class="lookup-control">
      <Search :size="17" aria-hidden="true" />
      <input id="run-id" v-model="runId" required placeholder="Paste a run ID" autocomplete="off">
      <button class="icon-button" type="submit" aria-label="Open run details" title="Open run details">
        <ArrowRight :size="18" aria-hidden="true" />
      </button>
    </div>
  </form>
</template>
