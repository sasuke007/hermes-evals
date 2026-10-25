<script setup lang="ts">
import { computed, ref, watchEffect } from 'vue';
import { RouterLink, useRoute, type RouteLocationRaw } from 'vue-router';
import { useVirtualList } from '@vueuse/core';
import type { RunRow, RunSortKey } from '@/api/types/runs';
import SkeletonRows from '@/components/ui/SkeletonRows.vue';
import StatusChip from '@/components/ui/StatusChip.vue';
import StatusDot from '@/components/ui/StatusDot.vue';
import type { DataTableSort, SkeletonColumn } from '@/components/ui/types';
import { MISSING, formatClock, formatCount } from '@/lib/format';
import { ROUTE_NAMES } from '@/router';
import { formatSeconds } from '@/components/overview/overview';

/**
 * The Runs table (Runs board): one row per run, in the order the API sorted them, inside a
 * 780px scroll box with a sticky header. Every column sorts (on the server); a checkbox per
 * row feeds the bulk bar; the task opens the run in the inspector over the table
 * (/experiments/:id/runs/:runId, keeping the filters). Above 500 rows only the rows in view
 * are drawn (useVirtualList). A row with a re-score in flight keeps its result and says so.
 */
const props = withDefaults(
  defineProps<{
    rows: RunRow[];
    experimentId: string;
    loading?: boolean;
    /** Dims the rows (a refresh failed; they are the last good data). */
    stale?: boolean;
  }>(),
  { loading: false, stale: false },
);
const selected = defineModel<string[]>('selected', { default: () => [] });
const sort = defineModel<DataTableSort | null>('sort', { default: null });
const emit = defineEmits<{ open: [runId: string] }>();
defineSlots<{ empty?: () => unknown }>();

const route = useRoute();

/** Rows drawn as they are up to here; past it the table virtualises. */
const VIRTUAL_ABOVE = 500;
const ROW_HEIGHT = 30;

interface Column {
  key: RunSortKey;
  label: string;
  right?: boolean;
}
const COLUMNS: Column[] = [
  { key: 'task', label: 'Task' },
  { key: 'configuration', label: 'Configuration' },
  { key: 'repetition', label: 'Rep', right: true },
  { key: 'attempts', label: 'Attempts', right: true },
  { key: 'status', label: 'Run status' },
  { key: 'score', label: 'Primary score' },
  { key: 'duration', label: 'Duration', right: true },
  { key: 'tokens', label: 'Tokens', right: true },
  { key: 'cost', label: 'Cost', right: true },
  { key: 'finished', label: 'Finished' },
];
/** Names, then numbers and times: the first click sorts names up and numbers down. */
const ASCENDING_FIRST = new Set<RunSortKey>(['task', 'configuration', 'repetition']);

function toggleSort(key: RunSortKey): void {
  if (sort.value?.key === key) {
    sort.value = { key, dir: sort.value.dir === 'asc' ? 'desc' : 'asc' };
  } else {
    sort.value = { key, dir: ASCENDING_FIRST.has(key) ? 'asc' : 'desc' };
  }
}
function ariaSort(key: RunSortKey): 'ascending' | 'descending' | 'none' {
  if (sort.value?.key !== key) return 'none';
  return sort.value.dir === 'asc' ? 'ascending' : 'descending';
}
function arrow(key: RunSortKey): string {
  if (sort.value?.key !== key) return '';
  return sort.value.dir === 'asc' ? '↑' : '↓';
}

// ── selection ────────────────────────────────────────────────────────────
const chosen = computed(() => new Set(selected.value));
const allSelected = computed(
  () => props.rows.length > 0 && props.rows.every((r) => chosen.value.has(r.id)),
);
const someSelected = computed(() => !allSelected.value && selected.value.length > 0);
function toggleAll(): void {
  selected.value = allSelected.value ? [] : props.rows.map((r) => r.id);
}
function toggle(id: string): void {
  selected.value = chosen.value.has(id)
    ? selected.value.filter((s) => s !== id)
    : [...selected.value, id];
}
const selectAll = ref<HTMLInputElement | null>(null);
watchEffect(() => {
  if (selectAll.value) selectAll.value.indeterminate = someSelected.value;
});

// ── rows, virtualised above 500 ──────────────────────────────────────────
const virtual = computed(() => props.rows.length > VIRTUAL_ABOVE);
const source = computed(() => props.rows);
const {
  list,
  containerProps: { ref: scrollBox, onScroll },
} = useVirtualList(source, { itemHeight: ROW_HEIGHT, overscan: 20 });
const shown = computed(() =>
  virtual.value ? list.value : props.rows.map((data, index) => ({ data, index })),
);
const padTop = computed(() => (virtual.value ? (shown.value[0]?.index ?? 0) * ROW_HEIGHT : 0));
const padBottom = computed(() => {
  if (!virtual.value) return 0;
  const last = shown.value[shown.value.length - 1]?.index ?? -1;
  return Math.max(0, props.rows.length - 1 - last) * ROW_HEIGHT;
});

const runLink = (row: RunRow): RouteLocationRaw => ({
  name: ROUTE_NAMES.experimentRun,
  params: { id: props.experimentId, runId: row.id },
  query: route.query,
});
const rowLabel = (row: RunRow): string =>
  `Select ${row.taskKey} ${row.configuration.name} rep ${row.repetition}`;
const cost = (v: number | null): string => (v === null ? MISSING : `$${v.toFixed(3)}`);

const skeleton: SkeletonColumn[] = [
  { width: 14, height: 14 },
  { width: [140, 130, 150, 120, 140, 130] },
  80,
  { width: 30, align: 'right' },
  { width: 30, align: 'right' },
  { width: 70, height: 16 },
  { width: 60, height: 16 },
  { width: 50, align: 'right' },
  { width: 50, align: 'right' },
  { width: 50, align: 'right' },
  60,
];
function onRow(row: RunRow, event: MouseEvent | KeyboardEvent): void {
  if ((event.target as HTMLElement | null)?.closest('a, button, input, label')) return;
  emit('open', row.id);
}
</script>

<template>
  <div
    ref="scrollBox"
    class="tbl max-h-780"
    data-testid="runs-table"
    :data-virtual="virtual ? 'true' : undefined"
    @scroll="onScroll"
  >
    <table class="dt h30 clickable" aria-label="Runs" :aria-busy="loading || undefined">
      <thead>
        <tr>
          <th class="w-34">
            <input
              ref="selectAll"
              type="checkbox"
              aria-label="Select all shown runs"
              :checked="allSelected"
              :disabled="loading || rows.length === 0"
              @change="toggleAll"
            />
          </th>
          <th
            v-for="c in COLUMNS"
            :key="c.key"
            scope="col"
            :class="{ 'text-right': c.right }"
            :aria-sort="ariaSort(c.key)"
          >
            <button
              type="button"
              class="inline-flex items-center gap-4 border-0 bg-transparent p-0 text-12"
              :class="sort?.key === c.key ? 'font-semibold text-text' : 'font-medium text-inherit'"
              :data-sort-key="c.key"
              @click="toggleSort(c.key)"
            >
              {{ c.label }} <span aria-hidden="true">{{ arrow(c.key) }}</span>
            </button>
          </th>
        </tr>
      </thead>
      <tbody v-if="loading && rows.length === 0">
        <SkeletonRows :columns="skeleton" :rows="6" />
      </tbody>
      <tbody v-else-if="rows.length === 0">
        <tr class="hover:[&>td]:bg-transparent">
          <td :colspan="COLUMNS.length + 1" class="whitespace-normal">
            <slot name="empty" />
          </td>
        </tr>
      </tbody>
      <tbody v-else :class="{ 'opacity-55': stale }">
        <tr v-if="padTop" aria-hidden="true" :style="{ height: `${padTop}px` }">
          <td :colspan="COLUMNS.length + 1" class="p-0" />
        </tr>
        <tr
          v-for="{ data: row } in shown"
          :key="row.id"
          :class="{ '[&>td]:bg-accent-soft': chosen.has(row.id) }"
          :data-run-id="row.id"
          :data-selected="chosen.has(row.id) ? 'true' : undefined"
          @click="onRow(row, $event)"
        >
          <td>
            <input
              type="checkbox"
              :aria-label="rowLabel(row)"
              :checked="chosen.has(row.id)"
              @change="toggle(row.id)"
            />
          </td>
          <td>
            <RouterLink :to="runLink(row)" class="font-mono text-12 text-text hover:text-text">{{
              row.taskKey
            }}</RouterLink>
          </td>
          <td class="font-mono text-12">{{ row.configuration.name }}</td>
          <td class="text-right">{{ row.repetition }}</td>
          <td class="text-right" :class="{ 'font-semibold text-err-text': row.attempts > 1 }">
            {{ row.attempts }}
          </td>
          <td>
            <StatusChip kind="run" :status="row.status" />
          </td>
          <td>
            <span class="inline-flex items-center gap-6">
              <StatusChip
                v-if="row.primaryScore"
                kind="score"
                :status="row.primaryScore.status"
                :title="
                  row.generation && row.generation > 1 ? `generation ${row.generation}` : undefined
                "
              />
              <span v-else class="text-text-3">{{ MISSING }}</span>
              <span
                v-if="row.rescorePending"
                class="inline-flex items-center gap-4 text-11 text-run-text"
                title="A re-score is queued; this result stays current until the new one publishes"
                data-testid="rescore-pending"
                ><StatusDot tone="run" mode="pulse" />re-scoring</span
              >
            </span>
          </td>
          <td class="text-right" :class="{ 'text-text-3': row.durationS === null }">
            {{ formatSeconds(row.durationS) }}
          </td>
          <td class="text-right" :class="{ 'text-text-3': !row.tokens }">
            {{ formatCount(row.tokens?.total) }}
          </td>
          <td class="text-right" :class="{ 'text-text-3': row.costUsd === null }">
            {{ cost(row.costUsd) }}
          </td>
          <td class="font-mono text-12" :class="row.finishedAt ? 'text-text-2' : 'text-text-3'">
            {{ formatClock(row.finishedAt) }}
          </td>
        </tr>
        <tr v-if="padBottom" aria-hidden="true" :style="{ height: `${padBottom}px` }">
          <td :colspan="COLUMNS.length + 1" class="p-0" />
        </tr>
      </tbody>
    </table>
  </div>
</template>
