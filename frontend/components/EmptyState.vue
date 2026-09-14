<script setup lang="ts">
import { Inbox } from "@lucide/vue";

withDefaults(defineProps<{
  title: string;
  description: string;
  hint?: string;
}>(), { hint: "" });
</script>

<template>
  <div class="state-panel state-empty" role="status" style="color:var(--landing-dim)">
    <div style="display:flex;align-items:center;gap:14px">
      <span style="display:grid;place-items:center;width:40px;height:40px;border-radius:12px;background:rgba(255,255,255,0.06);border:1px solid var(--landing-border);color:var(--landing-faint)"><Inbox :size="18" aria-hidden="true" /></span>
      <div>
        <h2 style="color:var(--landing-mist)">{{ title }}</h2>
        <p style="color:var(--landing-dim)">{{ description }}</p>
        <p v-if="hint" style="margin-top:6px;color:var(--landing-faint);font-size:11px;font-family:var(--font-mono)">{{ hint }}</p>
      </div>
    </div>
    <slot />
  </div>
</template>
