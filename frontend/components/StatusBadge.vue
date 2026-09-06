<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{ status: string }>();

const normalized = computed(() => props.status.toLowerCase());
const tone = computed(() => {
  if (['succeeded', 'active', 'done', 'healthy'].includes(normalized.value)) return 'success';
  if (['failed', 'error'].includes(normalized.value)) return 'danger';
  if (['running', 'waiting', 'queued'].includes(normalized.value)) return 'info';
  if (['disabled', 'draft', 'cancelled'].includes(normalized.value)) return 'neutral';
  return 'neutral';
});
</script>

<template>
  <span class="status-badge" :class="`status-${tone}`">{{ status }}</span>
</template>
