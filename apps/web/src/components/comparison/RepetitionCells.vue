<script setup lang="ts">
import { CELL_CLASSES, cellLabel, cellLook, type CellTip } from './cells';
import type { RepetitionCell } from '@/api/types/experiments';

/**
 * One configuration's repetitions of one task (Components 2 › RepetitionCells): a 16px button
 * per repetition, in repetition order, coloured by the selected key's status (src/components/
 * comparison/cells.ts). Clicking a cell opens its run; hovering or focusing one asks the grid
 * to show its tooltip (`tip`), so a grid of thousands of cells draws one tooltip, not one each.
 * Inside TaskGrid, `gridAttrs` gives each cell its place in the arrow-key grid.
 */
const props = withDefaults(
  defineProps<{
    cells: RepetitionCell[];
    taskKey: string;
    /** Configuration name, for the labels. */
    configuration: string;
    /** 16 in the grid, 12 in dense lists. */
    size?: 16 | 12;
    /** The arrow-key grid's attributes for the cell at `index` (useKeyboardGrid.cellAttrs). */
    gridAttrs?: ((index: number) => Record<string, unknown>) | null;
    /** The run whose tooltip is showing, and the tooltip's id, for aria-describedby. */
    describedRunId?: string | null;
    tooltipId?: string | null;
  }>(),
  { size: 16, gridAttrs: null, describedRunId: null, tooltipId: null },
);

const emit = defineEmits<{
  open: [runId: string];
  tip: [tip: CellTip | null, via: 'hover' | 'focus'];
}>();

function show(cell: RepetitionCell, event: Event, via: 'hover' | 'focus'): void {
  emit(
    'tip',
    {
      cell,
      taskKey: props.taskKey,
      configuration: props.configuration,
      el: event.currentTarget as HTMLElement,
      via,
    },
    via,
  );
}
</script>

<template>
  <div
    class="flex"
    :class="size === 16 ? 'gap-4' : 'gap-3'"
    role="group"
    :aria-label="`${configuration}, ${taskKey}`"
  >
    <button
      v-for="(cell, i) in cells"
      :key="cell.runId"
      type="button"
      class="block flex-none rounded-2 hover:outline-2 hover:outline-offset-1 hover:outline-text focus-visible:outline-text"
      :class="[size === 16 ? 'size-16' : 'size-12', CELL_CLASSES[cellLook(cell)]]"
      :aria-label="cellLabel(cell, taskKey, configuration)"
      :aria-describedby="tooltipId && describedRunId === cell.runId ? tooltipId : undefined"
      :data-look="cellLook(cell)"
      :data-run-id="cell.runId"
      v-bind="gridAttrs ? gridAttrs(i) : {}"
      @click="emit('open', cell.runId)"
      @mouseenter="show(cell, $event, 'hover')"
      @mouseleave="emit('tip', null, 'hover')"
      @focus="show(cell, $event, 'focus')"
      @blur="emit('tip', null, 'focus')"
    />
  </div>
</template>
