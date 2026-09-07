<script setup lang="ts">
import { computed } from "vue";

const props = defineProps<{ status: string }>();

const normalized = computed(() => props.status.toLowerCase().trim());
const tone = computed(() => {
  if (["succeeded", "success", "active", "done", "completed", "healthy", "ok"].includes(normalized.value)) return "success";
  if (["failed", "error", "dead"].includes(normalized.value)) return "danger";
  if (["running", "in_progress", "processing"].includes(normalized.value)) return "info";
  if (["waiting", "queued", "pending", "retrying"].includes(normalized.value)) return "warning";
  return "neutral"; // cancelled, draft, disabled, paused, and anything unrecognized
});
</script>

<template>
  <span class="status-badge" :class="`status-${tone}`">{{ status }}</span>
</template>
