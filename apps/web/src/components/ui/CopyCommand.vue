<script setup lang="ts">
import CopyButton from './CopyButton.vue';

/** A one-line shell command in a box with a copy button (System, ModelAccessStates). */
withDefaults(defineProps<{ command: string; label?: string }>(), { label: 'Copy command' });
</script>

<template>
  <span
    class="inline-flex max-w-full items-center gap-6 rounded-4 border border-border bg-surface-2 py-2 pr-4 pl-8"
    data-testid="copy-command"
  >
    <code class="truncate" :title="command">{{ command }}</code>
    <CopyButton :text="command" :label="label" />
  </span>
</template>
