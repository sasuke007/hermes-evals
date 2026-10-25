<script setup lang="ts">
import { computed } from 'vue';
import { MISSING } from '@/lib/format';
import type { KeyValueItem } from './types';

/**
 * Labels and values as a <dl>, in the three ways the boards draw them:
 *   grid    label column and value column (OverviewComplete's snapshot, the inspector's
 *           launch record, TaskDetail's limits); --text-2 labels.
 *   rows    one bordered row per item, 10px 16px, optionally two columns of rows
 *           (ConfigDetail's Fields, inside a panel).
 *   inline  label and value pairs on one wrapping line (the inspector header: Duration 52 s
 *           · Tokens 9,820 …); values in --text, medium.
 * A missing value is an en dash in --text-3. #value-<key> replaces a value (a chip, a link),
 * #label-<key> a label.
 */
const props = withDefaults(
  defineProps<{
    items: KeyValueItem[];
    layout?: 'grid' | 'rows' | 'inline';
    /** grid and rows: the label column, px. */
    labelWidth?: number;
    /** rows: one or two columns of rows. */
    columns?: 1 | 2;
    /** grid: px between rows and between the columns. */
    rowGap?: number;
    columnGap?: number;
  }>(),
  { layout: 'grid', labelWidth: 140, columns: 1, rowGap: 10, columnGap: 12 },
);

const missing = (item: KeyValueItem): boolean =>
  item.value === null || item.value === undefined || item.value === '';

const labelColumns = computed(() => `${props.labelWidth}px minmax(0, 1fr)`);

/** rows: no bottom border on the last row of items (the panel draws that edge). */
function lastRow(index: number): boolean {
  const n = props.items.length;
  if (props.columns === 1) return index === n - 1;
  const lastRowStart = n % 2 === 0 ? n - 2 : n - 1;
  return index >= lastRowStart;
}
</script>

<template>
  <dl
    v-if="layout === 'grid'"
    class="grid"
    :style="{
      gridTemplateColumns: labelColumns,
      rowGap: `${rowGap}px`,
      columnGap: `${columnGap}px`,
    }"
  >
    <template v-for="item in items" :key="item.key">
      <dt class="text-text-2" :data-key="item.key">
        <slot :name="`label-${item.key}`" :item="item">{{ item.label }}</slot>
      </dt>
      <dd
        :class="{
          'font-mono': item.mono,
          'text-text-3': missing(item) && !$slots[`value-${item.key}`],
        }"
      >
        <slot :name="`value-${item.key}`" :item="item">{{
          missing(item) ? MISSING : item.value
        }}</slot>
      </dd>
    </template>
  </dl>

  <dl v-else-if="layout === 'rows'" class="grid" :class="columns === 2 ? 'grid-cols-2' : ''">
    <div
      v-for="(item, i) in items"
      :key="item.key"
      class="grid gap-12 px-16 py-10"
      :class="[lastRow(i) ? '' : 'border-b border-border', { 'bg-accent-soft': item.highlight }]"
      :style="{ gridTemplateColumns: labelColumns }"
      :data-key="item.key"
    >
      <dt class="text-text-2">
        <slot :name="`label-${item.key}`" :item="item">{{ item.label }}</slot>
      </dt>
      <dd
        class="min-w-0"
        :class="{
          'font-mono': item.mono,
          'text-text-3': missing(item) && !$slots[`value-${item.key}`],
        }"
      >
        <slot :name="`value-${item.key}`" :item="item">{{
          missing(item) ? MISSING : item.value
        }}</slot>
      </dd>
    </div>
  </dl>

  <dl v-else class="flex flex-wrap gap-x-24 gap-y-4 text-text-2">
    <div v-for="item in items" :key="item.key" class="flex gap-6" :data-key="item.key">
      <dt>
        <slot :name="`label-${item.key}`" :item="item">{{ item.label }}</slot>
      </dt>
      <dd
        class="font-medium"
        :class="[
          missing(item) && !$slots[`value-${item.key}`] ? 'text-text-3' : 'text-text',
          { 'font-mono': item.mono },
        ]"
      >
        <slot :name="`value-${item.key}`" :item="item">{{
          missing(item) ? MISSING : item.value
        }}</slot>
      </dd>
    </div>
  </dl>
</template>
