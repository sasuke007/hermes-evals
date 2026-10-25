<script setup lang="ts">
import type { SkeletonColumn, SkeletonWidth } from './types';

/**
 * Loading placeholders at the real column widths, so nothing shifts when data arrives.
 * layout="table" renders <tr> rows (place inside <tbody>); layout="lines" renders bars in a
 * column. Mark the surrounding table or panel aria-busy="true"; the bars are aria-hidden.
 */
const props = withDefaults(
  defineProps<{
    columns: SkeletonColumn[];
    rows?: number;
    layout?: 'table' | 'lines';
  }>(),
  { rows: 6, layout: 'table' },
);

const css = (w: SkeletonWidth): string => (typeof w === 'number' ? `${w}px` : w);
/** One shimmering bar, 10px high unless the column says otherwise. */
const BAR = 'block h-10 animate-shimmer rounded-3 bg-surface-3';

function bar(column: SkeletonColumn, row: number): Record<string, string | undefined> {
  if (typeof column === 'number' || typeof column === 'string') return { width: css(column) };
  const widths = Array.isArray(column.width) ? column.width : [column.width];
  const width = widths[row % widths.length] ?? 80;
  return {
    width: css(width),
    height: column.height ? `${column.height}px` : undefined,
    marginLeft: column.align === 'right' ? 'auto' : undefined,
  };
}
const alignRight = (column: SkeletonColumn): boolean =>
  typeof column === 'object' && column.align === 'right';

const rowIndexes = (): number[] => Array.from({ length: props.rows }, (_, i) => i);
</script>

<template>
  <template v-if="layout === 'table'">
    <tr
      v-for="i in rowIndexes()"
      :key="i"
      class="hover:[&>td]:bg-transparent"
      data-testid="skeleton-row"
      aria-hidden="true"
    >
      <td v-for="(column, c) in columns" :key="c" :class="{ 'text-right': alignRight(column) }">
        <span :class="BAR" :style="bar(column, i)" />
      </td>
    </tr>
  </template>
  <div v-else class="flex flex-col gap-10" aria-hidden="true">
    <span v-for="i in rowIndexes()" :key="i" :class="BAR" :style="bar(columns[0] ?? '100%', i)" />
  </div>
</template>
