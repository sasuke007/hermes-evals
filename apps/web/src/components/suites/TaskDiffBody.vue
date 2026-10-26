<script setup lang="ts">
import { computed } from 'vue';
import type { JsonDiffEntry, TextDiffLine } from '@/api/types/suites';
import BaseTag from '@/components/ui/BaseTag.vue';
import { MISSING } from '@/lib/format';
import type { FileChange, FileRow } from './diffFiles';
import { diffCaption, sideBySide } from './diffRows';
import SideBySideDiff from './SideBySideDiff.vue';
import { inlineJson } from './suiteFormat';
import ZoneLabel from './ZoneLabel.vue';

/**
 * The body of a task diff (TaskDiff board), shared by the version diff on Task detail and a
 * draft task's diff on Review and save: the Files table with sizes and hashes, each changed
 * text (prompt.md, task.yaml, a small text fixture) side by side, and the reference answer on
 * the hidden panel, as changed values or, for a draft, as its text.
 */
const props = withDefaults(
  defineProps<{
    rows: FileRow[];
    fromLabel: string;
    toLabel: string;
    /** The changed texts to show side by side, in order. */
    texts: { path: string; lines: TextDiffLine[]; caption?: string | null }[];
    /** The reference answer's changed values (a version diff). */
    reference?: JsonDiffEntry[];
    /** The reference answer as text lines (a draft diff); drawn instead of `reference`. */
    referenceText?: TextDiffLine[] | null;
    /** Under the reference: "total_due 87,412.10 → 99,760.52. Never copied …". */
    referenceCaption?: string | null;
  }>(),
  { reference: () => [], referenceText: null, referenceCaption: null },
);

const MARK: Record<FileChange, string> = {
  changed: 'bg-run-soft text-run-text',
  added: 'bg-pass-soft text-pass-text',
  removed: 'bg-fail-soft text-fail-text',
  unchanged: 'bg-que-soft text-que-text',
};

const sides = computed(() =>
  props.texts.map((t) => ({
    ...t,
    rows: sideBySide(t.lines),
    caption: t.caption ?? diffCaption(t.lines),
  })),
);
const referenceRows = computed(() =>
  props.referenceText && props.referenceText.some((l) => l.kind !== 'same')
    ? sideBySide(props.referenceText)
    : null,
);
const showReference = computed(() => referenceRows.value !== null || props.reference.length > 0);
</script>

<template>
  <div class="flex flex-col gap-6 px-14 py-12">
    <span class="text-12 font-semibold text-text-2">Files</span>
    <div class="overflow-x-auto rounded-4 border border-border">
      <table class="dt h38 static" aria-label="Files">
        <thead>
          <tr>
            <th scope="col" class="w-100">Change</th>
            <th scope="col">Path</th>
            <th scope="col" class="text-right">Size</th>
            <th scope="col">Hash</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="f in rows"
            :key="f.path"
            :class="{ 'text-text-3': f.change === 'unchanged' }"
            :data-file="f.path"
            :data-change="f.change"
          >
            <td>
              <span
                class="inline-flex h-20 min-w-64 items-center justify-center rounded-3 px-6 text-11 font-medium"
                :class="MARK[f.change]"
                >{{ f.change }}</span
              >
            </td>
            <td class="font-mono text-12">{{ f.path }}</td>
            <td class="text-right font-mono text-12" :class="{ 'text-text-3': f.size === MISSING }">
              {{ f.size }}
            </td>
            <td>
              <span v-if="f.to" class="inline-flex items-center gap-6">
                <template v-if="f.from">
                  <BaseTag>{{ f.from }}</BaseTag>
                  <span class="text-text-3" aria-hidden="true">→</span>
                </template>
                <BaseTag>{{ f.to }}</BaseTag>
              </span>
              <span v-else class="text-text-3">{{ MISSING }}</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>

  <div
    v-for="t in sides"
    :key="t.path"
    class="flex flex-col gap-6 px-14 pt-4 pb-12"
    :data-text-diff="t.path"
  >
    <div class="flex items-baseline justify-between">
      <span class="font-mono text-12 font-semibold">{{ t.path }}</span>
      <span class="text-12 text-text-3">{{ t.caption }}</span>
    </div>
    <SideBySideDiff
      :rows="t.rows"
      :from-label="fromLabel"
      :to-label="toLabel"
      :label="`${t.path}, ${fromLabel} against ${toLabel}`"
    />
  </div>

  <div
    v-if="showReference"
    class="mx-14 mt-4 mb-14 flex flex-col rounded-6 border border-dashed border-border-strong bg-[repeating-linear-gradient(135deg,var(--surface)_0_10px,var(--surface-2)_10px_20px)]"
    data-testid="reference-diff"
  >
    <div
      class="flex items-center justify-between gap-10 border-b border-dashed border-border-strong px-12 py-8"
    >
      <span class="flex items-center gap-8 font-semibold">
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <path
            d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z M2.5 13.5l11-11"
            fill="none"
            stroke="currentColor"
            stroke-width="1.4"
            stroke-linecap="round"
          />
        </svg>
        Reference answer
        <span class="font-mono text-12 font-normal text-text-2">reference.json</span>
      </span>
      <ZoneLabel zone="hidden" />
    </div>
    <div class="flex flex-col gap-6 px-12 py-10">
      <SideBySideDiff
        v-if="referenceRows"
        :rows="referenceRows"
        :from-label="fromLabel"
        :to-label="toLabel"
        :label="`reference.json, ${fromLabel} against ${toLabel}`"
      />
      <div v-else class="overflow-hidden rounded-4 border border-border bg-surface">
        <div class="grid grid-cols-2 font-mono text-12 leading-20">
          <div class="border-r border-b border-border bg-surface-2 px-10 py-4 text-11 text-text-2">
            {{ fromLabel }}
          </div>
          <div class="border-b border-border bg-surface-2 px-10 py-4 text-11 text-text-2">
            {{ toLabel }}
          </div>
          <template v-for="entry in reference" :key="entry.path">
            <div
              class="border-r border-border px-10 break-words whitespace-pre-wrap"
              :class="entry.kind === 'added' ? 'bg-surface-2' : 'bg-fail-soft'"
            >
              <template v-if="entry.kind !== 'added'"
                >{{ entry.path }}:
                <span class="rounded-2 bg-fail/30 line-through">{{
                  inlineJson(entry.before)
                }}</span></template
              >
            </div>
            <div
              class="px-10 break-words whitespace-pre-wrap"
              :class="entry.kind === 'removed' ? 'bg-surface-2' : 'bg-pass-soft'"
            >
              <template v-if="entry.kind !== 'removed'"
                >{{ entry.path }}:
                <span class="rounded-2 bg-pass/30">{{ inlineJson(entry.after) }}</span></template
              >
            </div>
          </template>
        </div>
      </div>
      <span class="text-12 text-text-3">{{
        referenceCaption ?? 'Never copied into a run. Only the checks read it.'
      }}</span>
    </div>
  </div>
</template>
