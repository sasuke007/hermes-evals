<script setup lang="ts">
import EmptyState from '@/components/EmptyState.vue';
defineProps<{ title: string; body: string }>();
</script>

<template>
  <main class="page">
    <h1 class="page-title">{{ title }}</h1>
    <EmptyState :title="`No ${title.toLowerCase()} yet`" :body="body" />
  </main>
</template>
