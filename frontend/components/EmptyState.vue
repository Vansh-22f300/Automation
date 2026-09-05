<script setup lang="ts">
import { Inbox } from '@lucide/vue';

defineProps<{
  title: string;
  description: string;
}>();
</script>

<template>
  <div class="state-panel state-empty">
    <Inbox :size="28" aria-hidden="true" />
    <div>
      <h2>{{ title }}</h2>
      <p>{{ description }}</p>
    </div>
    <slot />
  </div>
</template>
