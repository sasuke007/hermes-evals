<script setup lang="ts">
import { computed, ref, shallowRef, useId, watch } from 'vue';
import { RouterLink, type RouteLocationRaw } from 'vue-router';
import { formatRate, formatSigned, MISSING } from '@/lib/format';
import CellTooltip from './CellTooltip.vue';
import RepetitionCells from './RepetitionCells.vue';
import { tallyCells, type CellTip, type GridSort } from './cells';
import type { ComparisonRow } from '@/api/types/experiments';
import { useKeyboardGrid } from '@/composables/useKeyboardGrid';

/**
 * The task grid (Comparison board, Components 2 › TaskGrid): one row per task with its id, the
 * baseline's repetitions and pass rate, the candidate's, and the signed Δ with a bar and the
 * change. Each cell opens its run; one card tooltip follows the hovered or focused cell. The
 * arrow keys move between cells (useKeyboardGrid: Tab enters at one cell, Home/End, Page
 * Up/Down, Enter opens), Esc hides the tooltip.
 *
 * Variants: `showDelta` false drops Δ and Change (one repetition, nothing scored yet); `dense`
 * 30px rows (one repetition); `provisional` adds each rate's passed/counted fraction; `bare`
 * sits inside another panel without its own border. Rows arrive filtered and ordered; the
 * header's sort buttons only ask (`sort`).
 */
const props = withDefaults(
  defineProps<{
    rows: ComparisonRow[];
    baseline: string;
    candidate: string;
    repetitions: number;
    showDelta?: boolean;
    provisional?: boolean;
    sort?: GridSort;
    sortable?: boolean;
    dense?: boolean;
    bare?: boolean;
    /** The task detail route for a task key, or null for plain text. */
    taskRoute?: ((taskKey: string) => RouteLocationRaw | null) | null;
  }>(),
  {
    showDelta: true,
    provisional: false,
    sort: 'delta',
    sortable: true,
    dense: false,
    bare: false,
    taskRoute: null,
  },
);

const emit = defineEmits<{ open: [runId: string]; sort: [sort: GridSort] }>();

const wrap = ref<HTMLElement | null>(null);
const tooltipId = `cell-tip-${useId()}`;

const grid = useKeyboardGrid({
  container: wrap,
  rows: () => props.rows.length,
  cols: (r) => {
    const row = props.rows[r];
    return row ? row.baseline.length + row.candidate.length : 0;
  },
  onActivate: (r, c) => {
    const row = props.rows[r];
    if (!row) return;
    const cell = c < row.baseline.length ? row.baseline[c] : row.candidate[c - row.baseline.length];
    if (cell) emit('open', cell.runId);
  },
});

// One tooltip for the whole grid: the cell the pointer or the keyboard reached last (the
// other one when that leaves); Esc hides it.
const hovered = shallowRef<CellTip | null>(null);
const focused = shallowRef<CellTip | null>(null);
const last = ref<'hover' | 'focus'>('hover');
const dismissed = ref(false);
const shown = computed(() => {
  if (dismissed.value) return null;
  return last.value === 'focus'
    ? (focused.value ?? hovered.value)
    : (hovered.value ?? focused.value);
});
const position = computed(() => {
  const tip = shown.value;
  if (!tip || !wrap.value) return null;
  const cell = tip.el.getBoundingClientRect();
  const box = wrap.value.getBoundingClientRect();
  return { left: cell.left - box.left + cell.width / 2, top: cell.top - box.top };
});

function onTip(tip: CellTip | null, via: 'hover' | 'focus'): void {
  if (via === 'hover') hovered.value = tip;
  else focused.value = tip;
  if (tip) last.value = via;
  dismissed.value = false;
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && shown.value) {
    dismissed.value = true;
    event.stopPropagation();
    return;
  }
  grid.onKeydown(event);
}

// Rows came or went (filter, sort, a live refresh): drop a tooltip whose cell left the page.
watch(
  () => props.rows,
  () => {
    if (hovered.value && !hovered.value.el.isConnected) hovered.value = null;
    if (focused.value && !focused.value.el.isConnected) focused.value = null;
  },
  { flush: 'post' },
);

/** Each row with its task link, worked out once per render. */
const items = computed(() =>
  props.rows.map((row) => ({ row, link: props.taskRoute?.(row.taskKey) ?? null })),
);

const baseAttrs = (r: number) => (i: number) => grid.cellAttrs(r, i);
const candAttrs = (r: number, offset: number) => (i: number) => grid.cellAttrs(r, offset + i);

function rate(value: number | null): string {
  return value === null ? MISSING : formatRate(value, 2);
}
function fraction(row: ComparisonRow, side: 'baseline' | 'candidate'): string | null {
  if (!props.provisional) return null;
  const t = tallyCells(row[side]);
  return t.counted > 0 ? `${t.passed}/${t.counted}` : null;
}

/** "+0.60", "−0.33", "0.00"; a Δ that rounds to zero keeps the sign of its change. */
function deltaText(row: ComparisonRow): string {
  if (row.delta === null) return MISSING;
  if (Number(row.delta.toFixed(2)) === 0 && row.change === 'improved') return '+0.00';
  if (Number(row.delta.toFixed(2)) === 0 && row.change === 'regressed') return '−0.00';
  return formatSigned(row.delta, 2);
}
function deltaClass(row: ComparisonRow): string {
  if (row.change === 'improved') return 'font-semibold text-pass-text';
  if (row.change === 'regressed') return 'font-semibold text-fail-text';
  return 'text-text-3';
}
function barStyle(row: ComparisonRow): Record<string, string> {
  const d = row.delta ?? 0;
  return { width: `${Math.min(1, Math.abs(d)) * 50}%`, [d >= 0 ? 'left' : 'right']: '50%' };
}
const CHANGE_CLASSES = {
  improved: 'bg-pass-soft text-pass-text',
  regressed: 'bg-fail-soft text-fail-text',
  unchanged: 'bg-surface-2 text-text-3',
} as const;
</script>

<template>
  <div
    ref="wrap"
    class="relative"
    data-testid="task-grid"
    @keydown="onKeydown"
    @mouseleave="hovered = null"
  >
    <div :class="bare ? 'overflow-x-auto' : 'tbl'">
      <table class="dt" :class="dense ? 'h30' : 'h36'" aria-label="Task grid">
        <thead>
          <tr>
            <th :aria-sort="sortable && sort === 'task' ? 'other' : undefined">
              <button
                v-if="sortable"
                type="button"
                class="inline-flex items-center gap-4 text-12"
                :class="sort === 'task' ? 'font-semibold text-text' : 'font-medium'"
                @click="emit('sort', 'task')"
              >
                Task<span v-if="sort === 'task'"> suite order</span>
              </button>
              <template v-else>Task</template>
            </th>
            <th>
              <span class="font-mono text-text">{{ baseline }}</span>
              <span v-if="repetitions > 1" class="font-normal text-text-3">
                rep 1 → {{ repetitions }}</span
              >
            </th>
            <th class="text-right">Pass</th>
            <th>
              <span class="font-mono text-text">{{ candidate }}</span>
              <span v-if="repetitions > 1" class="font-normal text-text-3">
                rep 1 → {{ repetitions }}</span
              >
            </th>
            <th class="text-right">Pass</th>
            <template v-if="showDelta">
              <th
                class="w-200 text-right"
                :aria-sort="sortable && sort === 'delta' ? 'descending' : undefined"
              >
                <button
                  v-if="sortable"
                  type="button"
                  class="inline-flex items-center gap-4 text-12"
                  :class="sort === 'delta' ? 'font-semibold text-text' : 'font-medium'"
                  @click="emit('sort', 'delta')"
                >
                  Δ<span v-if="sort === 'delta'"> ↓</span>
                </button>
                <template v-else>Δ</template>
              </th>
              <th>Change</th>
            </template>
          </tr>
        </thead>
        <tbody>
          <tr v-for="({ row, link }, r) in items" :key="row.taskKey" :data-task="row.taskKey">
            <td>
              <RouterLink v-if="link" :to="link" class="font-mono text-12 text-text">{{
                row.taskKey
              }}</RouterLink>
              <span v-else class="font-mono text-12">{{ row.taskKey }}</span>
            </td>
            <td>
              <RepetitionCells
                :cells="row.baseline"
                :task-key="row.taskKey"
                :configuration="baseline"
                :grid-attrs="baseAttrs(r)"
                :described-run-id="shown?.cell.runId ?? null"
                :tooltip-id="tooltipId"
                @open="emit('open', $event)"
                @tip="onTip"
              />
            </td>
            <td class="text-right" data-testid="pass-baseline">
              <span :class="{ 'text-text-3': row.passBaseline === null }">{{
                rate(row.passBaseline)
              }}</span
              ><span v-if="fraction(row, 'baseline')" class="text-12 text-text-3">{{
                ` ${fraction(row, 'baseline')}`
              }}</span>
            </td>
            <td>
              <RepetitionCells
                :cells="row.candidate"
                :task-key="row.taskKey"
                :configuration="candidate"
                :grid-attrs="candAttrs(r, row.baseline.length)"
                :described-run-id="shown?.cell.runId ?? null"
                :tooltip-id="tooltipId"
                @open="emit('open', $event)"
                @tip="onTip"
              />
            </td>
            <td class="text-right" data-testid="pass-candidate">
              <span :class="{ 'text-text-3': row.passCandidate === null }">{{
                rate(row.passCandidate)
              }}</span
              ><span v-if="fraction(row, 'candidate')" class="text-12 text-text-3">{{
                ` ${fraction(row, 'candidate')}`
              }}</span>
            </td>
            <template v-if="showDelta">
              <td class="text-right" data-testid="delta">
                <div class="flex items-center justify-end gap-10">
                  <span :class="deltaClass(row)">{{ deltaText(row) }}</span>
                  <span
                    class="relative h-8 w-100 flex-none rounded-2 bg-surface-2"
                    aria-hidden="true"
                  >
                    <span class="absolute -top-2 left-1/2 h-12 w-1 bg-border-strong" />
                    <span
                      v-if="row.change === 'improved' || row.change === 'regressed'"
                      class="absolute top-0 h-8 rounded-2"
                      :class="row.change === 'improved' ? 'bg-pass' : 'bg-fail'"
                      :style="barStyle(row)"
                    />
                  </span>
                </div>
              </td>
              <td>
                <span
                  v-if="row.change"
                  class="chip"
                  :class="CHANGE_CLASSES[row.change]"
                  data-testid="change"
                  >{{ row.change }}</span
                >
                <span v-else class="text-text-3">{{ MISSING }}</span>
              </td>
            </template>
          </tr>
        </tbody>
      </table>
    </div>
    <CellTooltip
      v-if="shown && position"
      :id="tooltipId"
      :cell="shown.cell"
      :task-key="shown.taskKey"
      :configuration="shown.configuration"
      class="-translate-x-1/2 -translate-y-full"
      :style="{ left: `${position.left}px`, top: `${position.top - 8}px` }"
    />
  </div>
</template>
