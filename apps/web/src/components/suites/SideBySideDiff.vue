<script setup lang="ts">
import { computed, ref } from 'vue';
import { foldRows, type DiffCell, type DiffRow } from './diffRows';

/**
 * Two versions of a text side by side (TaskDiff board): the older on the left, the newer on
 * the right, line numbers and a +/− gutter on each side, removed lines on the fail tint and
 * added ones on the pass tint, the changed part of a line marked. Unchanged stretches fold;
 * "Show N unchanged lines" opens one.
 */
const props = defineProps<{
  rows: DiffRow[];
  fromLabel: string;
  toLabel: string;
  /** Accessible name: "prompt.md, v1 against v2". */
  label: string;
}>();

const opened = ref<Set<number>>(new Set());
const items = computed(() => foldRows(props.rows));

const CELL: Record<DiffCell['kind'], string> = {
  same: '',
  removed: 'bg-fail-soft',
  added: 'bg-pass-soft',
  empty: 'bg-surface-2',
};
const MARK: Record<DiffCell['kind'], string> = {
  same: '',
  empty: '',
  removed: 'rounded-2 bg-fail/30 line-through',
  added: 'rounded-2 bg-pass/30',
};
const sign = (c: DiffCell): string => (c.kind === 'removed' ? '−' : c.kind === 'added' ? '+' : '');

function open(id: number): void {
  opened.value = new Set([...opened.value, id]);
}
</script>

<template>
  <div
    class="overflow-hidden rounded-4 border border-border bg-surface"
    role="table"
    :aria-label="label"
  >
    <div class="grid grid-cols-2 font-mono text-12 leading-20" role="rowgroup">
      <div role="row" class="contents">
        <div
          role="columnheader"
          class="border-r border-b border-border bg-surface-2 px-10 py-4 text-11 text-text-2"
        >
          {{ fromLabel }}
        </div>
        <div
          role="columnheader"
          class="border-b border-border bg-surface-2 px-10 py-4 text-11 text-text-2"
        >
          {{ toLabel }}
        </div>
      </div>
      <template v-for="(item, i) in items" :key="i">
        <template v-if="item.kind === 'fold' && !opened.has(item.id)">
          <div role="row" class="col-span-2">
            <div role="cell">
              <button
                type="button"
                class="w-full border-0 bg-surface-2 px-10 py-2 text-left font-sans text-12 text-text-3 hover:text-text"
                @click="open(item.id)"
              >
                Show {{ item.rows.length }} unchanged lines
              </button>
            </div>
          </div>
        </template>
        <template v-else>
          <div
            v-for="(row, j) in item.kind === 'row' ? [item.row] : item.rows"
            :key="j"
            role="row"
            class="contents"
            :data-changed="row.changed ? 'true' : undefined"
          >
            <div
              v-for="(cell, side) in [row.left, row.right]"
              :key="side"
              role="cell"
              class="grid min-h-20 grid-cols-[34px_16px_minmax(0,1fr)] break-words whitespace-pre-wrap"
              :class="[CELL[cell.kind], side === 0 ? 'border-r border-border' : '']"
              :data-kind="cell.kind"
            >
              <span class="pr-6 text-right text-text-3 select-none">{{ cell.n ?? '' }}</span>
              <span class="text-text-3 select-none" aria-hidden="true">{{ sign(cell) }}</span>
              <span
                ><template v-for="(part, k) in cell.parts" :key="k"
                  ><span v-if="part.marked" :class="MARK[cell.kind]" data-marked="true">{{
                    part.text
                  }}</span
                  ><template v-else>{{ part.text || ' ' }}</template></template
                ></span
              >
            </div>
          </div>
        </template>
      </template>
    </div>
  </div>
</template>
