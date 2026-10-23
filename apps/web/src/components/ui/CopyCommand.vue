<script setup lang="ts">
import CopyButton from './CopyButton.vue';

/** A one-line shell command in a .cmd box with a copy button (System, ModelAccessStates). */
withDefaults(defineProps<{ command: string; label?: string }>(), { label: 'Copy command' });
</script>

<template>
  <span class="cmd">
    <code :title="command">{{ command }}</code>
    <CopyButton :text="command" :label="label" />
  </span>
</template>
