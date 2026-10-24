<script setup lang="ts">
// Placeholder: the page builder replaces this file and keeps its props.
/**
 * new: /configurations/new · duplicate: /configurations/new?from=<id> ·
 * edit: /configurations/:id/edit.
 */
defineProps<{ mode: 'new' | 'edit' | 'duplicate'; configurationId?: string }>();
</script>

<template>
  <main class="page">
    <h1 class="page-title">Configuration</h1>
    <p class="t2">The configuration form is being built.</p>
  </main>
</template>
