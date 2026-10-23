<script setup lang="ts">
/** Kept at its original path for existing imports; the component lives in ui/EmptyState.vue.
    Props and listeners fall through to it; slots are forwarded. */
import EmptyState from './ui/EmptyState.vue';
</script>

<template>
  <EmptyState>
    <template v-for="(_, name) in $slots" #[name]="slotProps">
      <slot :name="name" v-bind="slotProps ?? {}" />
    </template>
  </EmptyState>
</template>
