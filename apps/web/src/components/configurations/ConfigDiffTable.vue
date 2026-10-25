<script setup lang="ts">
import { computed, useId } from 'vue';
import SkeletonRows from '@/components/ui/SkeletonRows.vue';
import type { ConfigDiff, ConfigField } from '@/api/types/configurations';

/**
 * One column per configuration version, one row per field (Components 2 › ConfigDiffTable):
 * rows whose values differ are tinted and marked ≠, and a cell that differs from the first
 * column (the reference: the baseline) is bold. The line above names exactly which fields
 * differ. Rows come from GET /configurations/diff, so New experiment, the list's Compare and
 * the detail's Compare with… all show the same thing.
 *   table   the line, "Only show differences", the table (the configuration pages)
 *   inline  a summary bar with what the count means for a verdict, then a boxed table;
 *           `roles` label the columns (New experiment › "Compare side by side")
 *   panel   one bordered section: a header with `title`, the line in bold, "Only show
 *           differences" and #actions (Close, a version select), then the table
 *           (ConfigList › "Compare configurations", ConfigDetail › Compare with…); #notice
 *           sits under the header (an ErrorBanner), `loading` draws skeleton rows
 * `name` is the column header, never a row.
 */
const props = withDefaults(
  defineProps<{
    /** null: fewer than two configurations are chosen. */
    diff: ConfigDiff | null;
    variant?: 'table' | 'inline' | 'panel';
    /** inline: a word under each column name, "baseline" or "candidate". */
    roles?: string[] | null;
    /** panel: the section's heading. */
    title?: string;
    /** panel: the diff is on its way (skeleton rows under the header). */
    loading?: boolean;
  }>(),
  { variant: 'table', roles: null, title: 'Compare configurations', loading: false },
);
const onlyDifferences = defineModel<boolean>('onlyDifferences', { default: false });

const uid = useId();
const filterId = `diff-only-${uid}`;
const headingId = `diff-title-${uid}`;

/** "No fields differ." · "1 field differs: skills" · "2 fields differ: skills, mcp_servers". */
const line = computed(() => {
  if (!props.diff || props.diff.columns.length < 2) return 'Pick two configurations to compare.';
  const fields: ConfigField[] = props.diff.differing.filter((f) => f !== 'name');
  if (fields.length === 0) return 'No fields differ.';
  return `${fields.length} ${fields.length === 1 ? 'field differs' : 'fields differ'}: ${fields.join(', ')}`;
});
const count = computed(() => props.diff?.differing.filter((f) => f !== 'name').length ?? 0);
const hint = computed(() => {
  if (props.variant !== 'inline' || !props.diff || props.diff.columns.length < 2) return '';
  if (count.value === 1) return 'This experiment is controlled: one variable changes.';
  if (count.value > 1) {
    return 'More than one variable changes. A verdict will not tell you which one mattered.';
  }
  return '';
});

const rows = computed(() =>
  (props.diff?.rows ?? [])
    .filter((row) => row.field !== 'name')
    .filter((row) => props.variant === 'inline' || !onlyDifferences.value || row.differs)
    .map((row) => ({
      ...row,
      cells: row.values.map((text, i) => ({ text, bold: i > 0 && text !== row.values[0] })),
    })),
);
const showTable = computed(() => !!props.diff && props.diff.columns.length >= 2);
const skeleton = [{ width: 110 }, { width: [140, 110, 160] }, { width: [140, 110, 160] }];
</script>

<template>
  <section
    v-if="variant === 'panel'"
    class="rounded-6 border border-border bg-surface"
    :aria-labelledby="headingId"
    :aria-busy="loading || undefined"
    :data-differing="count"
  >
    <div
      class="flex flex-wrap items-center justify-between gap-10 border-b border-border px-16 py-12"
    >
      <div class="flex flex-col gap-2">
        <h2 :id="headingId" class="text-15 font-semibold">{{ title }}</h2>
        <span v-if="!loading && !$slots.notice" class="text-text-2"
          ><b class="text-text" data-testid="diff-line">{{ line }}</b></span
        >
      </div>
      <div class="flex flex-wrap items-center gap-12">
        <label
          v-if="showTable || loading"
          :for="filterId"
          class="inline-flex cursor-pointer items-center gap-6 text-text-2"
        >
          <input
            :id="filterId"
            v-model="onlyDifferences"
            type="checkbox"
            class="size-14 accent-accent"
          />
          Only show differences
        </label>
        <slot name="actions" />
      </div>
    </div>
    <slot name="notice" />
    <div v-if="loading || showTable" class="overflow-x-auto">
      <table class="dt static h40" aria-label="Configuration fields side by side">
        <thead>
          <tr>
            <th class="w-200">Field</th>
            <template v-if="showTable">
              <th v-for="column in diff!.columns" :key="column.versionId">
                <span class="font-mono text-text">{{ column.name }}</span
                >{{ ' ' }}<span class="tag">v{{ column.version }}</span>
              </th>
            </template>
            <template v-else
              ><th />
              <th
            /></template>
          </tr>
        </thead>
        <tbody v-if="loading">
          <SkeletonRows :columns="skeleton" :rows="9" />
        </tbody>
        <tbody v-else>
          <tr
            v-for="row in rows"
            :key="row.field"
            :class="{ '[&>td]:bg-accent-soft': row.differs }"
            :data-field="row.field"
            :data-differs="row.differs ? 'true' : 'false'"
          >
            <td>
              <span class="flex items-center gap-6">
                <span class="w-12 font-mono font-semibold text-accent" aria-hidden="true">{{
                  row.differs ? '≠' : ''
                }}</span>
                <span class="font-mono text-12">{{ row.field }}</span>
                <span v-if="row.differs" class="sr-only">(differs)</span>
              </span>
            </td>
            <td
              v-for="(cell, i) in row.cells"
              :key="i"
              class="font-mono text-12"
              :class="{ 'font-semibold': cell.bold }"
            >
              {{ cell.text }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
  <div v-else class="flex flex-col gap-8" :data-differing="count">
    <div
      v-if="variant === 'inline'"
      class="flex flex-wrap items-center gap-8 rounded-4 bg-surface-2 px-12 py-8"
      role="status"
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 14 14"
        aria-hidden="true"
        class="flex-none text-accent"
      >
        <circle cx="7" cy="7" r="5.6" fill="none" stroke="currentColor" stroke-width="1.4" />
        <path
          d="M4.5 7.2l1.8 1.8 3.3-3.6"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
        />
      </svg>
      <span class="font-medium" data-testid="diff-line">{{ line }}</span>
      <span v-if="hint" class="text-12 text-text-3">{{ hint }}</span>
    </div>
    <div v-else class="flex flex-wrap items-center justify-between gap-8">
      <span class="font-medium" data-testid="diff-line">{{ line }}</span>
      <label
        v-if="showTable"
        :for="filterId"
        class="inline-flex cursor-pointer items-center gap-6 text-text-2"
      >
        <input
          :id="filterId"
          v-model="onlyDifferences"
          type="checkbox"
          class="size-14 accent-accent"
        />
        Only show differences
      </label>
    </div>

    <div
      v-if="showTable"
      :class="variant === 'inline' ? 'overflow-x-auto rounded-4 border border-border' : 'tbl'"
    >
      <table class="dt static" aria-label="Configuration fields side by side">
        <thead>
          <tr>
            <th :style="{ width: variant === 'inline' ? '190px' : '180px' }">Field</th>
            <th v-for="(column, i) in diff!.columns" :key="column.versionId">
              <span class="font-mono">{{ column.name }}</span>
              <template v-if="roles && roles[i]">
                {{ ' ' }}<span class="font-normal text-text-3">{{ roles[i] }}</span>
              </template>
              <template v-else
                >{{ ' ' }}<span class="tag">v{{ column.version }}</span></template
              >
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="row in rows"
            :key="row.field"
            :class="{ '[&>td]:bg-accent-soft': row.differs }"
            :data-field="row.field"
            :data-differs="row.differs ? 'true' : 'false'"
          >
            <td>
              <span class="flex items-center gap-6">
                <span class="w-12 font-mono font-semibold text-accent" aria-hidden="true">{{
                  row.differs ? '≠' : ''
                }}</span>
                <span class="font-mono text-12">{{ row.field }}</span>
                <span v-if="row.differs" class="sr-only">(differs)</span>
              </span>
            </td>
            <td
              v-for="(cell, i) in row.cells"
              :key="i"
              class="font-mono text-12"
              :class="{ 'font-semibold': cell.bold }"
            >
              {{ cell.text }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
