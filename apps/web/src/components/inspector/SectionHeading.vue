<script setup lang="ts">
/**
 * A numbered section heading of the run inspector (RunInspector › .sh): "1 Outcome",
 * 15/22 semibold with the number in mono --text-3. The default slot adds a caption after it
 * ("14 events · live", "partial · written before the cancel").
 */
defineProps<{ n: number; title: string; id?: string }>();
</script>

<template>
  <h2 :id="id" class="flex flex-wrap items-baseline gap-10 text-15 font-semibold">
    <span class="font-mono text-12 font-medium text-text-3">{{ n }}</span
    >{{ title }}<slot />
  </h2>
</template>
