<script setup lang="ts">
import { AlertCircle, RefreshCw } from '@lucide/vue';

defineProps<{ message: string }>();
defineEmits<{ retry: [] }>();
</script>

<template>
  <div class="state-panel state-error" role="alert">
    <AlertCircle :size="24" aria-hidden="true" />
    <div>
      <h2>Couldn’t load this view</h2>
      <p>{{ message }}</p>
    </div>
    <button class="button button-secondary" type="button" @click="$emit('retry')">
      <RefreshCw :size="16" aria-hidden="true" />
      Try again
    </button>
  </div>
</template>
