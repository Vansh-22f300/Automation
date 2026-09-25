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
  { label: "Workflows", to: "/workflows", icon: Workflow },
  { label: "Runs", to: "/runs", icon: PlaySquare },
  { label: "Connections", to: "/connections", icon: Cable },
];

// Prefix-aware active match so sibling detail routes (e.g. /runs/:runId) still
// highlight their parent nav item — NuxtLink's exact router-link-active does not.
const route = useRoute();
function isActive(to: string): boolean {
  return route.path === to || route.path.startsWith(`${to}/`);
}
</script>

<template>
  <aside id="app-sidebar" class="sidebar" :class="{ 'is-open': open }" aria-label="Primary">
    <div style="position:relative">
      <!-- subtle aurora behind brand -->
      <div aria-hidden="true" style="position:absolute; inset:-20px -12px auto -12px; height:80px; background:radial-gradient(300px 60px at 20% 0%, rgba(183,164,251,0.08), transparent 70%); pointer-events:none" />
      <NuxtLink class="brand" to="/workflows" aria-label="AI Workforce workspace" style="position:relative" @click="$emit('close')">
        <span class="brand-mark" style="background:linear-gradient(135deg, #fff 0%, #e8e8ef 100%); color:#0a0a11; box-shadow:0 0 0 1px rgba(255,255,255,0.08) inset"><Activity :size="16" aria-hidden="true" /></span>
        <span class="brand-copy">
          <strong style="letter-spacing:-0.02em">AI Workforce</strong>
          <span style="color:var(--landing-faint)">Operations workspace</span>
        </span>
      </NuxtLink>
    </div>
    <p class="sidebar-kicker" style="display:flex; align-items:center; gap:8px"><span style="width:6px;height:6px;border-radius:999px;background:var(--landing-mint);box-shadow:0 0 0 4px rgba(139,245,201,0.12)" aria-hidden="true" /> Workspace</p>
    <nav class="sidebar-nav" aria-label="Primary navigation">
      <NuxtLink
        to="/"
        class="nav-link"
        style="opacity:0.9"
        @click="$emit('close')"
      >
        <LayoutDashboard :size="16" aria-hidden="true" />
        <span>Overview</span>
        <span style="margin-left:auto; font-size:10px; color:var(--landing-faint); letter-spacing:0.06em; text-transform:uppercase">landing</span>
      </NuxtLink>
      <NuxtLink
        v-for="item in navigation"
        :key="item.to"
        :to="item.to"
        class="nav-link"
        :class="{ 'router-link-active': isActive(item.to) }"
        @click="$emit('close')"
      >
        <component :is="item.icon" :size="16" aria-hidden="true" />
        <span>{{ item.label }}</span>
      </NuxtLink>
    </nav>
    <div class="sidebar-footer">
      <span class="environment-dot" style="background:var(--landing-mint); box-shadow:0 0 0 4px rgba(139,245,201,0.14)" aria-hidden="true" />
      <div>
        <strong style="font-size:11px; letter-spacing:0.06em; text-transform:uppercase; color:var(--landing-faint)">Local development</strong>
        <p style="font-size:11px">Fastify via Nuxt proxy</p>
      </div>
    </div>
  </aside>
</template>
