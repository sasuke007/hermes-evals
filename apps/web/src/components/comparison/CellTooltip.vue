<script setup lang="ts">
import { computed } from 'vue';
import { CELL_TONES, cellComment, cellLook, cellMeta, cellWord } from './cells';
import type { RepetitionCell } from '@/api/types/experiments';
import { TONE_CLASSES } from '@/lib/statusTones';

/**
 * A grid cell's card tooltip (Comparison board): "task · configuration · rep n" with the
 * status word, the run's line ("scored · 52 s · attempt 1") and the primary score's comment or
 * the execution error. TaskGrid places one over the hovered or focused cell; the cell points
 * at it with aria-describedby.
 */
const props = defineProps<{
  id: string;
  cell: RepetitionCell;
  taskKey: string;
  configuration: string;
}>();

const look = computed(() => cellLook(props.cell));
const comment = computed(() => cellComment(props.cell));
</script>

<template>
  <span
    :id="id"
    role="tooltip"
    class="pointer-events-none absolute z-10 flex w-300 flex-col gap-4 rounded-6 border border-border bg-surface px-12 py-10 whitespace-normal text-text shadow-float"
    data-testid="cell-tooltip"
  >
    <span class="flex items-center justify-between gap-8">
      <span class="font-mono text-12 font-semibold"
        >{{ taskKey }} · {{ configuration }} · rep&nbsp;{{ cell.repetition }}</span
      >
      <span class="chip" :class="TONE_CLASSES[CELL_TONES[look]].chip">{{ cellWord(look) }}</span>
    </span>
    <span class="font-mono text-12 text-text-3">{{ cellMeta(cell) }}</span>
    <span v-if="comment" class="text-12 leading-18 text-text-2">{{ comment }}</span>
  </span>
</template>
