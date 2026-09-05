<script setup lang="ts">
defineProps<{
  title: string;
  description: string;
}>();
</script>

<template>
  <header class="page-header">
    <div>
      <p class="eyebrow">AI Workforce</p>
      <h1>{{ title }}</h1>
      <p class="page-description">{{ description }}</p>
    </div>
    <slot name="actions" />
  </header>
</template>
