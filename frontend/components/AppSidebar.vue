<script setup lang="ts">
import {
  Activity,
  Cable,
  LayoutDashboard,
  PlaySquare,
  Workflow,
} from "@lucide/vue";

withDefaults(defineProps<{ open?: boolean }>(), { open: false });
defineEmits<{ close: [] }>();

const navigation = [
  { label: "Dashboard", to: "/", icon: LayoutDashboard },
  { label: "Workflows", to: "/workflows", icon: Workflow },
  { label: "Runs", to: "/runs", icon: PlaySquare },
  { label: "Connections", to: "/connections", icon: Cable },
];
</script>

<template>
  <aside id="app-sidebar" class="sidebar" :class="{ 'is-open': open }" aria-label="Primary">
    <NuxtLink class="brand" to="/workflows" aria-label="AI Workforce workspace" @click="$emit('close')">
      <span class="brand-mark"><Activity :size="19" aria-hidden="true" /></span>
      <span class="brand-copy">
        <strong>AI Workforce</strong>
        <span>Operations workspace</span>
      </span>
    </NuxtLink>
    <p class="sidebar-kicker">Operations workspace</p>
    <nav class="sidebar-nav" aria-label="Primary navigation">
      <NuxtLink
        v-for="item in navigation"
        :key="item.to"
        :to="item.to"
        class="nav-link"
        @click="$emit('close')"
      >
        <component :is="item.icon" :size="18" aria-hidden="true" />
        <span>{{ item.label }}</span>
      </NuxtLink>
    </nav>
    <div class="sidebar-footer">
      <span class="environment-dot" aria-hidden="true" />
      <div>
        <strong>Local development</strong>
        <p>Fastify API via Nuxt proxy</p>
      </div>
    </div>
  </aside>
</template>
