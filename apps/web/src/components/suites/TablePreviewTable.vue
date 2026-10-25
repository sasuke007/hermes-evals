<script setup lang="ts">
import { computed } from 'vue';
import type { TablePreview } from '@/api/types/suites';

/**
 * The first rows of a tabular fixture (TaskDetail board): every value as written, in mono,
 * with a column of numbers aligned right.
 */
const props = defineProps<{ preview: TablePreview; label: string }>();

const NUMBER = /^-?\d+(\.\d+)?$/;
/** Columns whose every non-empty value is a number. */
const numeric = computed(() =>
  props.preview.columns.map((_, c) => {
    const values = props.preview.rows.map((r) => r[c] ?? '').filter((v) => v !== '');
    return values.length > 0 && values.every((v) => NUMBER.test(v));
  }),
);
</script>

<template>
  <div class="overflow-x-auto rounded-4 border border-border">
    <table class="dt th30 inset14 static" :aria-label="`First rows of ${label}`">
      <thead>
        <tr>
          <th
            v-for="(column, c) in preview.columns"
            :key="c"
            scope="col"
            :class="{ 'text-right': numeric[c] }"
          >
            {{ column }}
          </th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(row, r) in preview.rows" :key="r">
          <td
            v-for="(_, c) in preview.columns"
            :key="c"
            class="font-mono text-12"
            :class="{ 'text-right': numeric[c] }"
          >
            {{ row[c] ?? '' }}
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
