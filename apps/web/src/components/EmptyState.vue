<script setup lang="ts">
/**
 * Kept at its original path for existing imports. The component lives in ui/EmptyState.vue;
 * import that one for the action, align, panel and size options.
 */
import EmptyState from './ui/EmptyState.vue';

defineProps<{ title: string; body?: string | null }>();
</script>

<template>
  <EmptyState :title="title" :body="body ?? null">
    <template v-for="(_, name) in $slots" #[name]="slotProps">
      <slot :name="name" v-bind="slotProps ?? {}" />
    </template>
  </EmptyState>
</template>
