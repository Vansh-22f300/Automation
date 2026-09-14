<script setup lang="ts">
import { Inbox } from "@lucide/vue";

withDefaults(defineProps<{
  title: string;
  description: string;
  hint?: string;
}>(), { hint: "" });
</script>

<template>
  <div class="state-panel state-empty" role="status">
    <div style="display:flex;align-items:center;gap:12px">
      <span style="display:grid;place-items:center;width:36px;height:36px;border-radius:10px;background:var(--surface-sunken);border:1px solid var(--border);color:var(--text-muted)"><Inbox :size="18" aria-hidden="true" /></span>
      <div>
        <h2>{{ title }}</h2>
        <p>{{ description }}</p>
        <p v-if="hint" style="margin-top:6px;color:var(--text-muted);font-size:12px">{{ hint }}</p>
      </div>
    </div>
    <slot />
  </div>
</template>
