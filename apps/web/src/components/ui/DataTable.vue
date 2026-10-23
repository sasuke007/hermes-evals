<script setup lang="ts" generic="Row extends object">
import { computed, ref, useSlots, watch } from 'vue';
import EmptyState from './EmptyState.vue';
import ErrorBanner from './ErrorBanner.vue';
import SegmentedControl from './SegmentedControl.vue';
import SkeletonRows from './SkeletonRows.vue';
import type {
  DataTableColumn,
  DataTableSort,
  Density,
  RowKey,
  SkeletonColumn,
  SegmentOption,
} from './types';

/**
 * The table behind every list. Columns are declared; cells can be overridden with scoped
 * slots (#cell-status="{ row, value }"). The header sticks inside the table's own scroll box;
 * sticky columns stick when it scrolls sideways.
 *
 * States: loading (skeleton rows at the column widths) · empty (EmptyState in the body, header
 * kept, 6 rows high) · error (ErrorBanner above, last rows dimmed) · selected rows (the bulk bar
 * replaces the toolbar) · live rows (sorting on a liveKeys column freezes the order until the
 * user sorts again, with the hint "Sort is paused while live").
 */
const props = withDefaults(
  defineProps<{
    columns: DataTableColumn<Row>[];
    rows: Row[];
    /** Field name or function giving each row's id. */
    rowKey?: string | ((row: Row) => RowKey);
    /** client: the table sorts rows itself · external: rows arrive sorted (server or page). */
    sortMode?: 'client' | 'external';
    selectable?: boolean;
    /** Remembers density per table in localStorage under hermes-evals.density.<tableId>. */
    tableId?: string | null;
    /** Shows the Compact / Default control in the toolbar. */
    showDensity?: boolean;
    loading?: boolean;
    skeletonRows?: number;
    /** Verbatim message: shows an ErrorBanner above the table and dims the rows. */
    error?: string | null;
    errorTitle?: string;
    errorHint?: string | null;
    retryLabel?: string | null;
    liveKeys?: string[];
    /** Rows open something: pointer cursor, Enter opens, row-click is emitted. */
    clickable?: boolean;
    /** With clickable rows: Cmd/Ctrl-click opens this in a new tab. */
    rowHref?: ((row: Row) => string | undefined) | null;
    rowClass?: ((row: Row) => string | Record<string, boolean> | undefined) | null;
    emptyTitle?: string;
    emptyBody?: string | null;
    /** Accessible name of the table. */
    label?: string | null;
    selectAllLabel?: string;
    rowLabel?: ((row: Row) => string) | null;
    /** Extra class on the table: h40, h44, static… (see main.css). */
    tableClass?: string | null;
  }>(),
  {
    rowKey: 'id',
    sortMode: 'client',
    selectable: false,
    tableId: null,
    showDensity: false,
    loading: false,
    skeletonRows: 6,
    error: null,
    errorTitle: 'Could not load',
    errorHint: null,
    retryLabel: 'Retry',
    liveKeys: () => [],
    clickable: false,
    rowHref: null,
    rowClass: null,
    emptyTitle: 'Nothing here yet',
    emptyBody: null,
    label: null,
    selectAllLabel: 'Select all rows',
    rowLabel: null,
    tableClass: null,
  },
);
const emit = defineEmits<{
  'row-click': [row: Row, event: MouseEvent | KeyboardEvent];
  retry: [];
}>();
const sort = defineModel<DataTableSort | null>('sort', { default: null });
const selected = defineModel<RowKey[]>('selected', { default: () => [] });
const density = defineModel<Density>('density', { default: 'default' });
const slots = useSlots();

// ── density, remembered per table ────────────────────────────────────────
const storageKey = computed(() => (props.tableId ? `hermes-evals.density.${props.tableId}` : null));
if (storageKey.value) {
  try {
    const saved = localStorage.getItem(storageKey.value);
    if (saved === 'compact' || saved === 'default') density.value = saved;
  } catch {
    /* storage unavailable */
  }
}
watch(density, (value) => {
  if (!storageKey.value) return;
  try {
    localStorage.setItem(storageKey.value, value);
  } catch {
    /* storage unavailable */
  }
});
const densityOptions: SegmentOption<Density>[] = [
  { value: 'compact', label: 'Compact' },
  { value: 'default', label: 'Default' },
];

// ── keys and values ──────────────────────────────────────────────────────
function keyOf(row: Row): RowKey {
  if (typeof props.rowKey === 'function') return props.rowKey(row);
  return (row as Record<string, unknown>)[props.rowKey] as RowKey;
}
function valueOf(row: Row, column: DataTableColumn<Row>): unknown {
  return (row as Record<string, unknown>)[column.key];
}
function textOf(row: Row, column: DataTableColumn<Row>): string {
  if (column.format) return column.format(row);
  const value = valueOf(row, column);
  return value === null || value === undefined || value === '' ? '–' : String(value);
}
function isMissing(row: Row, column: DataTableColumn<Row>): boolean {
  if (column.format) return false;
  const value = valueOf(row, column);
  return value === null || value === undefined || value === '';
}

// ── sorting ──────────────────────────────────────────────────────────────
function compare(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}
function sortRows(rows: Row[], s: DataTableSort | null): Row[] {
  if (!s || props.sortMode === 'external') return rows;
  const column = props.columns.find((c) => c.key === s.key);
  if (!column) return rows;
  const pick = column.sortValue ?? ((row: Row) => valueOf(row, column));
  const sign = s.dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => sign * compare(pick(a), pick(b)));
}

const liveSort = computed(() => !!sort.value && props.liveKeys.includes(sort.value.key));
const frozenOrder = ref<RowKey[] | null>(null);
watch(
  [() => sort.value?.key, () => sort.value?.dir, () => props.rows.length === 0],
  () => {
    frozenOrder.value = liveSort.value ? sortRows(props.rows, sort.value).map(keyOf) : null;
  },
  { immediate: true },
);

const displayRows = computed<Row[]>(() => {
  const sorted = sortRows(props.rows, sort.value);
  const order = frozenOrder.value;
  if (!liveSort.value || !order) return sorted;
  const byKey = new Map(sorted.map((row) => [keyOf(row), row] as const));
  const kept = order.map((k) => byKey.get(k)).filter((row): row is Row => row !== undefined);
  const known = new Set(order);
  return [...kept, ...sorted.filter((row) => !known.has(keyOf(row)))];
});

function toggleSort(column: DataTableColumn<Row>): void {
  if (sort.value?.key === column.key) {
    sort.value = { key: column.key, dir: sort.value.dir === 'asc' ? 'desc' : 'asc' };
  } else {
    sort.value = { key: column.key, dir: column.align === 'right' ? 'desc' : 'asc' };
  }
}
function ariaSort(column: DataTableColumn<Row>): 'ascending' | 'descending' | 'none' | undefined {
  if (!column.sortable) return undefined;
  if (sort.value?.key !== column.key) return 'none';
  return sort.value.dir === 'asc' ? 'ascending' : 'descending';
}

// ── selection ────────────────────────────────────────────────────────────
const selectedSet = computed(() => new Set(selected.value));
const allKeys = computed(() => props.rows.map(keyOf));
const allSelected = computed(
  () => allKeys.value.length > 0 && allKeys.value.every((k) => selectedSet.value.has(k)),
);
const someSelected = computed(() => !allSelected.value && selected.value.length > 0);
function toggleAll(): void {
  selected.value = allSelected.value ? [] : [...allKeys.value];
}
function toggleRow(row: Row): void {
  const key = keyOf(row);
  selected.value = selectedSet.value.has(key)
    ? selected.value.filter((k) => k !== key)
    : [...selected.value, key];
}
function clearSelection(): void {
  selected.value = [];
}

// ── rows ─────────────────────────────────────────────────────────────────
const isClickable = computed(() => props.clickable || !!props.rowHref);
function onRowActivate(row: Row, event: MouseEvent | KeyboardEvent): void {
  if (!isClickable.value) return;
  const target = event.target as HTMLElement | null;
  if (target?.closest('a, button, input, label, select, textarea')) return;
  const href = props.rowHref?.(row);
  if (href && event instanceof MouseEvent && (event.metaKey || event.ctrlKey)) {
    window.open(href, '_blank', 'noopener');
    return;
  }
  emit('row-click', row, event);
}

const colCount = computed(() => props.columns.length + (props.selectable ? 1 : 0));
const widthOf = (w: number | string | undefined): string | undefined =>
  w === undefined ? undefined : typeof w === 'number' ? `${w}px` : w;

const skeletonColumns = computed<SkeletonColumn[]>(() => {
  const cols: SkeletonColumn[] = props.columns.map((c) => ({
    width: c.skeleton ?? (typeof c.width === 'number' ? Math.round(c.width * 0.6) : '60%'),
    align: c.align === 'right' ? 'right' : 'left',
  }));
  return props.selectable ? [{ width: 14, height: 14 }, ...cols] : cols;
});

const showBulk = computed(() => selected.value.length > 0 && !!slots.bulk);
const showToolbar = computed(
  () => props.showDensity || !!slots.toolbar || showBulk.value || liveSort.value,
);
</script>

<template>
  <div class="data-table">
    <ErrorBanner
      v-if="error"
      tone="error"
      :title="errorTitle"
      :detail="error"
      :hint="errorHint"
      :retry-label="retryLabel"
      @retry="emit('retry')"
    />
    <div v-if="showToolbar" class="dtt">
      <div v-if="showBulk" class="bulk" role="region" aria-label="Bulk actions">
        <span class="bulk-count">{{ selected.length }} selected</span>
        <slot name="bulk" :selected="selected" :clear="clearSelection" />
        <button type="button" class="btn sm ghost" @click="clearSelection">Clear</button>
      </div>
      <div v-else class="dtt-left"><slot name="toolbar" /></div>
      <div class="dtt-right">
        <span v-if="liveSort" class="cap">Sort is paused while live</span>
        <template v-if="showDensity">
          <span class="cap">Density</span>
          <SegmentedControl v-model="density" :options="densityOptions" label="Row density" />
        </template>
      </div>
    </div>
    <div class="tbl">
      <table
        class="dt"
        :class="[{ compact: density === 'compact', clickable: isClickable }, tableClass]"
        :aria-label="label ?? undefined"
        :aria-busy="loading || undefined"
      >
        <thead>
          <tr>
            <th v-if="selectable" class="sel-col">
              <input
                type="checkbox"
                :checked="allSelected"
                :indeterminate="someSelected"
                :aria-label="selectAllLabel"
                :disabled="loading || rows.length === 0"
                @change="toggleAll"
              />
            </th>
            <th
              v-for="column in columns"
              :key="column.key"
              :class="{ r: column.align === 'right', 'sticky-col': column.sticky }"
              :style="{ width: widthOf(column.width) }"
              :aria-sort="ariaSort(column)"
              scope="col"
            >
              <slot :name="`head-${column.key}`" :column="column">
                <button
                  v-if="column.sortable"
                  type="button"
                  class="sortbtn"
                  :class="{ sorted: sort?.key === column.key }"
                  @click="toggleSort(column)"
                >
                  {{ column.label }}
                  <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                    <path
                      v-if="sort?.key === column.key && sort.dir === 'asc'"
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
                <template v-else>{{ column.label }}</template>
              </slot>
            </th>
          </tr>
        </thead>
        <tbody v-if="loading">
          <SkeletonRows :columns="skeletonColumns" :rows="skeletonRows" />
        </tbody>
        <tbody v-else-if="rows.length === 0">
          <tr class="empty-row">
            <td :colspan="colCount">
              <slot name="empty">
                <EmptyState :title="emptyTitle" :body="emptyBody" :panel="false" />
              </slot>
            </td>
          </tr>
        </tbody>
        <tbody v-else :class="{ dimmed: !!error }">
          <tr
            v-for="row in displayRows"
            :key="keyOf(row)"
            :class="[{ selected: selectedSet.has(keyOf(row)) }, rowClass?.(row)]"
            :tabindex="isClickable ? 0 : undefined"
            @click="onRowActivate(row, $event)"
            @keydown.enter="onRowActivate(row, $event)"
          >
            <td v-if="selectable" class="sel-col">
              <input
                type="checkbox"
                :checked="selectedSet.has(keyOf(row))"
                :aria-label="rowLabel ? rowLabel(row) : 'Select row'"
                @change="toggleRow(row)"
              />
            </td>
            <td
              v-for="column in columns"
              :key="column.key"
              :class="{
                r: column.align === 'right',
                mono: column.mono,
                'sticky-col': column.sticky,
                t3: isMissing(row, column),
              }"
            >
              <slot
                :name="`cell-${column.key}`"
                :row="row"
                :value="valueOf(row, column)"
                :column="column"
                >{{ textOf(row, column) }}</slot
              >
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.data-table {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}
.dtt {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.dtt-left,
.dtt-right {
  display: flex;
  align-items: center;
  gap: 8px;
}
.dtt-right {
  margin-left: auto;
}
.bulk {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 36px;
  padding: 0 12px;
  border-radius: 4px;
  background: var(--accent-soft);
  color: var(--text);
}
.bulk-count {
  font-weight: 500;
}
.sel-col {
  width: 36px;
}
td.mono {
  font-size: 12px;
}
.sortbtn svg {
  opacity: 0;
}
.sortbtn:hover svg,
.sortbtn:focus-visible svg,
.sortbtn.sorted svg {
  opacity: 1;
}
.sortbtn.sorted {
  color: var(--text);
  font-weight: 600;
}
.sticky-col {
  position: sticky;
  left: 0;
  background: var(--surface);
}
th.sticky-col {
  z-index: 2;
  background: var(--surface-2);
}
tr.selected td {
  background: var(--accent-soft);
}
.dimmed {
  opacity: 0.55;
}
.empty-row td {
  height: 192px;
  white-space: normal;
}
.empty-row:hover td {
  background: transparent;
}
</style>
