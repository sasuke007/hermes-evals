<script setup lang="ts" generic="T extends string | number">
/** A row of aria-pressed buttons: status filters, density, task filters ("All 12"). */
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

const textOf = (option: SegmentOption<T>): string =>
  option.count === null || option.count === undefined
    ? option.label
    : `${option.label} ${option.count}`;
</script>

<template>
  <div class="seg" :class="{ md: size === 'md' }" role="group" :aria-label="label">
    <button
      v-for="option in options"
      :key="String(option.value)"
      type="button"
      :aria-pressed="option.value === model ? 'true' : 'false'"
      @click="model = option.value"
    >
      {{ textOf(option) }}
    </button>
  </div>
</template>
