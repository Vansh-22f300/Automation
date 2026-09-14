<script setup lang="ts">
import { AlertCircle, RefreshCw } from "@lucide/vue";

defineProps<{ message: string }>();
defineEmits<{ retry: [] }>();

function friendly(message: string): string {
  if (message.includes("NUXT_PUBLIC_API_KEY") || message.includes("Add NUXT_PUBLIC_API_KEY")) return "Missing API key — add NUXT_PUBLIC_API_KEY to frontend/.env and restart the dev server.";
  if (message.includes("could not be reached") || message.includes("backend")) return "Backend unavailable — start the Fastify API on :3000 (pnpm dev) and refresh.";
  if (message.toLowerCase().includes("unauthorized") || message.includes("401")) return "Not authorized — check your API key and tenant.";
  return message;
}
</script>

<template>
  <div class="state-panel state-error" role="alert" aria-live="polite">
    <span style="display:grid;place-items:center;width:36px;height:36px;border-radius:10px;background:var(--danger-bg);border:1px solid #f3c6c1;color:var(--danger-text)"><AlertCircle :size="18" aria-hidden="true" /></span>
    <div>
      <h2>Couldn’t load this view</h2>
      <p>{{ friendly(message) }}</p>
    </div>
    <button class="button button-secondary" type="button" @click="$emit('retry')">
      <RefreshCw :size="16" aria-hidden="true" />
      Try again
    </button>
  </div>
</template>
