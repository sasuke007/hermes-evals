<script setup lang="ts">
import { CELL_CLASSES, type CellLook } from './cells';

/**
 * The key under the task grid (Comparison board): what each cell look means, the unscored
 * looks while the experiment is provisional, cancelled when a cell is, and how to use the
 * grid.
 */
withDefaults(defineProps<{ provisional?: boolean; cancelled?: boolean }>(), {
  provisional: false,
  cancelled: false,
});

const FINAL: [CellLook, string][] = [
  ['passed', 'passed'],
  ['failed', 'failed'],
  ['error', 'error / execution_error'],
  ['ungradable', 'ungradable'],
];
const PENDING: [CellLook, string][] = [
  ['running', 'running'],
  ['scoring', 'scoring'],
  ['queued', 'queued'],
];
</script>

<template>
  <div class="flex flex-wrap gap-x-20 gap-y-6 text-12 text-text-3" data-testid="comparison-legend">
    <span v-for="[look, word] in FINAL" :key="look" class="inline-flex items-center gap-6"
      ><span class="block size-16 flex-none rounded-2" :class="CELL_CLASSES[look]" />{{
        word
      }}</span
    >
    <span v-if="provisional" class="inline-flex items-center gap-14">
      <span v-for="[look, word] in PENDING" :key="look" class="inline-flex items-center gap-6"
        ><span class="block size-16 flex-none rounded-2" :class="CELL_CLASSES[look]" />{{
          word
        }}</span
      >
    </span>
    <span v-if="cancelled" class="inline-flex items-center gap-6"
      ><span
        class="block size-16 flex-none rounded-2"
        :class="CELL_CLASSES.cancelled"
      />cancelled</span
    >
    <span>Hover a cell for details · click to open the run · arrow keys move between cells</span>
  </div>
</template>
