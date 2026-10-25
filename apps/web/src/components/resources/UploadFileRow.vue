<script setup lang="ts">
import { formatBytes } from '@/lib/format';

/**
 * The chosen file at the top of step 2: its name in mono and its size, with Replace (back
 * to step 1) when `replaceable`. `oversize` sets the size in the failure colour (a document
 * over 50 MB).
 */
withDefaults(
  defineProps<{
    name: string;
    sizeBytes: number;
    replaceable?: boolean;
    oversize?: boolean;
  }>(),
  { replaceable: false, oversize: false },
);
defineEmits<{ replace: [] }>();
</script>

<template>
  <div
    class="flex items-center justify-between gap-12 rounded-4 border border-border bg-surface-2 px-12 py-10"
    data-testid="upload-file"
  >
    <span class="min-w-0 truncate font-mono text-12" :title="name">{{ name }}</span>
    <span class="flex flex-none items-center gap-10">
      <span
        class="text-12"
        :class="oversize ? 'font-semibold text-fail-text' : 'text-text-3'"
        data-testid="upload-size"
        >{{ formatBytes(sizeBytes) }}</span
      >
      <button
        v-if="replaceable"
        type="button"
        class="btn ghost h-24 px-6 text-12"
        @click="$emit('replace')"
      >
        Replace
      </button>
    </span>
  </div>
</template>
