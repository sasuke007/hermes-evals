<script setup lang="ts">
/**
 * The four steps of Import tasks (SA.9): done steps ticked in pass colours, the current one
 * filled in the accent and marked aria-current, the next ones outlined.
 */
defineProps<{ current: number }>();

const STEPS = ['Upload', 'Map columns', 'Shared settings', 'Preview'];
</script>

<template>
  <ol aria-label="Import steps" class="flex list-none flex-wrap items-center gap-10 p-0">
    <template v-for="(label, i) in STEPS" :key="label">
      <li v-if="i > 0" aria-hidden="true" class="h-1 w-40 bg-border-strong" />
      <li
        class="flex items-center gap-8"
        :class="i + 1 === current ? 'font-semibold' : 'text-text-2'"
        :aria-current="i + 1 === current ? 'step' : undefined"
      >
        <span
          class="inline-flex size-22 items-center justify-center rounded-full border font-mono text-11"
          :class="
            i + 1 < current
              ? 'border-pass bg-pass-soft text-pass-text'
              : i + 1 === current
                ? 'border-accent bg-accent text-on-accent'
                : 'border-border-strong bg-surface text-text-3'
          "
          >{{ i + 1 < current ? '✓' : i + 1 }}</span
        >{{ label }}
      </li>
    </template>
  </ol>
</template>
