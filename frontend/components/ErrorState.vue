<script setup lang="ts">
import { AlertCircle, RefreshCw } from "@lucide/vue";

defineProps<{ message: string }>();
defineEmits<{ retry: [] }>();

function friendly(message: string): string {
  // The browser now reaches Fastify only through the same-origin Nitro BFF, so
  // these messages describe the BFF's states, not a browser-held API key.
  if (message.includes("not configured") || message.includes("proxy")) return "Server not configured — set NUXT_API_KEY for the Nitro BFF and restart the server.";
  if (message.includes("did not respond in time") || message.includes("timed out")) return "The API took too long to respond — please try again.";
  if (message.includes("could not be reached") || message.includes("backend")) return "Backend unavailable — start the Fastify API on :3000 (pnpm dev) and refresh.";
  if (message.toLowerCase().includes("unauthorized") || message.includes("401")) return "Not authorized — check the server API key and tenant.";
  return message;
}
</script>

<template>
  <div class="state-panel state-error" role="alert" aria-live="polite" style="color:var(--landing-dim)">
    <span style="display:grid;place-items:center;width:40px;height:40px;border-radius:12px;background:rgba(255,107,107,0.12);border:1px solid rgba(255,107,107,0.22);color:var(--landing-danger-strong)"><AlertCircle :size="18" aria-hidden="true" /></span>
    <div>
      <h2 style="color:var(--landing-danger)">Couldn’t load this view</h2>
      <p style="color:var(--landing-dim)">{{ friendly(message) }}</p>
    </div>
    <button class="button button-secondary" type="button" style="border-radius:999px" @click="$emit('retry')">
      <RefreshCw :size="16" aria-hidden="true" />
      Try again
    </button>
  </div>
</template>
