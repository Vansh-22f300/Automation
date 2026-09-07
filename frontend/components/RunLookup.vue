<script setup lang="ts">
import { ArrowRight } from "@lucide/vue";
import { ref } from "vue";

const runId = ref("");
const router = useRouter();

async function openRun(): Promise<void> {
  const trimmed = runId.value.trim();
  if (trimmed !== "") await router.push(`/runs/${encodeURIComponent(trimmed)}`);
}
</script>

<template>
  <form class="run-lookup" @submit.prevent="openRun">
    <label for="run-id">Run ID</label>
    <div class="lookup-control">
      <input
        id="run-id"
        v-model="runId"
        required
        placeholder="e.g. 01993a8b-..."
        autocomplete="off"
      />
      <button
        class="icon-button-secondary"
        type="submit"
        aria-label="Open run details"
        title="Open run details"
      >
        <ArrowRight :size="18" aria-hidden="true" />
      </button>
    </div>
  </form>
</template>
