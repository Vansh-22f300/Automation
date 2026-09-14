<script setup lang="ts">
import { ref, watch } from 'vue';

const route = useRoute();
const isOpen = ref(false);

watch(() => route.fullPath, () => {
  isOpen.value = false;
});

function toggle() {
  isOpen.value = !isOpen.value;
}
function close() {
  isOpen.value = false;
}
</script>

<template>
  <div class="app-shell">
    <a href="#main" class="skip-link">Skip to main content</a>
    <div class="mobile-topbar" role="banner">
      <NuxtLink class="brand brand-compact" to="/workflows" aria-label="AI Workforce home">
        <span class="brand-mark"><span aria-hidden="true" style="font-size:14px;font-weight:650">◈</span></span>
        <span class="brand-copy"><strong>AI Workforce</strong></span>
      </NuxtLink>
      <button class="landing-hamburger" type="button" :aria-expanded="isOpen ? 'true' : 'false'" aria-controls="app-sidebar" aria-label="Toggle navigation" @click="toggle">
        <span aria-hidden="true" style="font-size:18px;line-height:1">{{ isOpen ? '✕' : '☰' }}</span>
      </button>
    </div>

    <AppSidebar :open="isOpen" @close="close" />
    <div v-if="isOpen" class="sidebar-overlay is-open" aria-hidden="true" @click="close" />

    <main id="main" class="app-main" tabindex="-1">
      <slot />
    </main>
  </div>
</template>
