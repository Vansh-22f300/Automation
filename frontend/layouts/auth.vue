<script setup lang="ts">
// Minimal shell for the logged-out login page. It reuses the workspace's
// `.app-main` dark styling context (so shared `.panel` / `.button` / control
// classes render in their dark variants) but omits the authenticated sidebar.
</script>

<template>
  <div class="auth-shell">
    <a href="#main" class="skip-link">Skip to main content</a>
    <main id="main" class="app-main auth-main" tabindex="-1">
      <slot />
    </main>
  </div>
</template>

<style scoped>
.auth-shell {
  min-height: 100vh;
  background: var(--landing-void);
  color: var(--landing-mist);
}
/* Two-class selector beats the global single-class `.app-main`, so this centres
   the login card while keeping the dark background, ambient, and control
   overrides that `.app-main` provides. */
.auth-shell .app-main {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  max-width: none;
}
</style>
