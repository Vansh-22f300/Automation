<script setup lang="ts">
import { Activity, Cable, LayoutDashboard, PlaySquare, Workflow } from '@lucide/vue';

const navigation = [
  { label: 'Dashboard', to: '/', icon: LayoutDashboard },
  { label: 'Workflows', to: '/workflows', icon: Workflow },
  { label: 'Runs', to: '/runs', icon: PlaySquare },
  { label: 'Connections', to: '/connections', icon: Cable },
];
</script>

<template>
  <aside class="sidebar">
    <NuxtLink class="brand" to="/" aria-label="AI Workforce dashboard">
      <span class="brand-mark"><Activity :size="19" /></span>
      <span>AI Workforce</span>
    </NuxtLink>
    <nav class="sidebar-nav" aria-label="Primary navigation">
      <NuxtLink v-for="item in navigation" :key="item.to" :to="item.to" class="nav-link">
        <component :is="item.icon" :size="18" aria-hidden="true" />
        <span>{{ item.label }}</span>
      </NuxtLink>
    </nav>
    <div class="sidebar-footer">
      <span class="environment-dot" />
      <span>Local development</span>
    </div>
  </aside>
</template>
