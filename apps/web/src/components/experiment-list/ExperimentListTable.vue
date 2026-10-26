<script setup lang="ts">
import { RouterLink, useRouter } from 'vue-router';
import type { ExperimentListRow } from '@/api/types/experiments';
import DataTable from '@/components/ui/DataTable.vue';
import ProgressBar from '@/components/ui/ProgressBar.vue';
import type { DataTableColumn, DataTableSort } from '@/components/ui/types';
import { formatDateTime, formatUsd } from '@/lib/format';
import { ROUTE_NAMES } from '@/router';
import ExperimentStatusCell from './ExperimentStatusCell.vue';
import VerdictCell from './VerdictCell.vue';
import { progressLabel, progressTone } from './listText';

/**
 * The Experiment list's table (ExperimentList board): ten columns of comparable numbers, right
 * aligned in tabular figures. A row opens the experiment's Overview; a verdict chip opens its
 * Comparison for that candidate. Only Created sorts (newest first by default). Live rows are
 * patched in place by the store, so they never reorder. Names longer than their column (Name
 * 260px, Configurations 240px, a chip's candidate 160px) end in an ellipsis with the whole
 * name on hover, so the table fits the page (Phase 5 #23).
 */
withDefaults(
  defineProps<{
    rows: ExperimentListRow[];
    loading?: boolean;
    /** The last refresh failed: the rows shown are older, so they are dimmed. */
    stale?: boolean;
  }>(),
  { loading: false, stale: false },
);
const sort = defineModel<DataTableSort | null>('sort', { default: null });
const router = useRouter();

const columns: DataTableColumn<ExperimentListRow>[] = [
  { key: 'name', label: 'Name', skeleton: [220, 180, 240, 200, 160, 210] },
  { key: 'suite', label: 'Suite', skeleton: 70 },
  { key: 'configurations', label: 'Configurations', skeleton: [140, 120, 160, 100, 150, 130] },
  { key: 'repetitions', label: 'Reps', align: 'right', skeleton: 20 },
  { key: 'totalRuns', label: 'Runs', align: 'right', skeleton: 28 },
  { key: 'progress', label: 'Progress', width: 200, skeleton: 150 },
  { key: 'status', label: 'Status', skeleton: { width: 64, height: 16 } },
  { key: 'verdict', label: 'Verdict', skeleton: { width: 90, height: 16 } },
  {
    key: 'createdAt',
    label: 'Created',
    sortable: true,
    sortValue: (row) => Date.parse(row.createdAt),
    format: (row) => formatDateTime(row.createdAt),
    skeleton: 80,
  },
  {
    key: 'costUsd',
    label: 'Est. cost',
    align: 'right',
    format: (row) => formatUsd(row.costUsd),
    skeleton: 40,
  },
];

/** The whole Configurations cell, for the hover of a truncated one. */
const configurationsTitle = (row: ExperimentListRow): string =>
  `${row.baseline.name} · ${row.candidates.map((c) => c.name).join(', ')}`;

const overview = (row: ExperimentListRow) => ({
  name: ROUTE_NAMES.experimentOverview,
  params: { id: row.id },
});
const hrefOf = (row: ExperimentListRow): string => router.resolve(overview(row)).href;

function open(row: ExperimentListRow): void {
  void router.push(overview(row));
}
</script>

<template>
  <DataTable
    v-model:sort="sort"
    :columns="columns"
    :rows="rows"
    :loading="loading"
    :row-href="hrefOf"
    :row-class="() => (stale ? 'opacity-55' : undefined)"
    label="Experiments"
    table-class="h40"
    @row-click="open"
  >
    <template #head-configurations>
      Configurations <span class="font-normal text-text-3">baseline · candidates</span>
    </template>
    <template #head-createdAt="{ column }">
      <button
        type="button"
        class="inline-flex items-center gap-4 border-0 bg-transparent p-0 text-12 font-semibold text-text"
        :aria-label="`Created, sorted ${sort?.dir === 'asc' ? 'oldest' : 'newest'} first`"
        :data-sorted="sort?.key === column.key ? sort.dir : undefined"
        @click="sort = { key: 'createdAt', dir: sort?.dir === 'asc' ? 'desc' : 'asc' }"
      >
        Created
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path
            v-if="sort?.dir === 'asc'"
            d="M5 8V2M2.5 4.5L5 2l2.5 2.5"
            fill="none"
            stroke="currentColor"
            stroke-width="1.4"
          />
          <path
            v-else
            d="M5 2v6M2.5 5.5L5 8l2.5-2.5"
            fill="none"
            stroke="currentColor"
            stroke-width="1.4"
          />
        </svg>
      </button>
    </template>

    <template #cell-name="{ row }">
      <RouterLink
        :to="overview(row)"
        class="block max-w-260 truncate font-medium text-text"
        :title="row.name"
        data-testid="experiment-name"
        >{{ row.name }}</RouterLink
      >
    </template>
    <template #cell-suite="{ row }">
      <span class="font-mono text-12">{{ row.suite.name }}</span
      >{{ ' ' }}<span class="text-12 font-semibold">v{{ row.suite.versionNumber }}</span>
    </template>
    <template #cell-configurations="{ row }">
      <span
        class="block max-w-240 truncate"
        :title="configurationsTitle(row)"
        data-testid="experiment-configurations"
        ><span class="font-mono text-12 font-semibold">{{ row.baseline.name }}</span
        ><span class="text-text-3"> · </span
        ><span class="font-mono text-12 text-text-2">{{
          row.candidates.map((c) => c.name).join(', ')
        }}</span></span
      >
    </template>
    <template #cell-progress="{ row }">
      <div class="flex items-center gap-10">
        <ProgressBar
          :max="row.totalRuns"
          :value="row.doneRuns"
          :tone="progressTone(row)"
          :label="progressLabel(row)"
          :height="6"
          :width="110"
        />
        <span class="font-mono text-12">{{ row.doneRuns }} / {{ row.totalRuns }}</span>
      </div>
    </template>
    <template #cell-status="{ row }">
      <ExperimentStatusCell :row="row" />
    </template>
    <template #cell-verdict="{ row }">
      <VerdictCell :row="row" />
    </template>
    <template #cell-createdAt="{ row }">
      <span class="text-text-2">{{ formatDateTime(row.createdAt) }}</span>
    </template>
    <template #cell-costUsd="{ row }">
      <span :class="{ 'text-text-3': row.costUsd === null }">{{ formatUsd(row.costUsd) }}</span>
    </template>

    <template #empty><slot name="empty" /></template>
  </DataTable>
</template>
