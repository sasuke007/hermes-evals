<script setup lang="ts" generic="T extends string | number">
/**
 * A row of aria-pressed buttons: status filters, density, task filters ("All 12", the count
 * in --text-3 as the Experiment list and Comparison boards draw it). Labels never wrap. The
 * row clips its corners, so a button's focus ring is drawn inside it, above its neighbours.
 */
import type { SegmentOption } from './types';

withDefaults(
  defineProps<{
    options: SegmentOption<T>[];
    /** aria-label of the group. */
    label: string;
    /** sm: 28px buttons (Components 1) · md: 30px (Experiment list, Comparison). */
    size?: 'sm' | 'md';
  }>(),
  { size: 'sm' },
);
const model = defineModel<T>({ required: true });
</script>

<template>
  <div
    class="inline-flex overflow-hidden rounded-4 border border-border-strong"
    role="group"
    :aria-label="label"
  >
    <button
      v-for="option in options"
      :key="String(option.value)"
      type="button"
      class="border-0 border-r border-border-strong bg-surface px-10 text-12 font-medium whitespace-nowrap text-text-2 last:border-r-0 focus-visible:relative focus-visible:z-1 focus-visible:-outline-offset-2 aria-pressed:bg-surface-3 aria-pressed:text-text"
      :class="size === 'md' ? 'h-30' : 'h-28'"
      :aria-pressed="option.value === model ? 'true' : 'false'"
      @click="model = option.value"
    >
      {{ option.label }}
      <span v-if="option.count !== null && option.count !== undefined" class="text-text-3">{{
        option.count
      }}</span>
    </button>
  </div>
</template>
