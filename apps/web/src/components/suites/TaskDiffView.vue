<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink, type RouteLocationRaw } from 'vue-router';
import type { TaskDiff, TaskFileChange, TextDiffLine } from '@/api/types/suites';
import BaseTag from '@/components/ui/BaseTag.vue';
import { formatDateTime, MISSING, shortHash, formatBytes, plural } from '@/lib/format';
import { diffCaption, sideBySide } from './diffRows';
import SideBySideDiff from './SideBySideDiff.vue';
import { inlineJson } from './suiteFormat';
import ZoneLabel from './ZoneLabel.vue';

/**
 * A task's changes from one version to the next (TaskDiff board, plan 4.5): the file list
 * marked changed, added, removed or unchanged with sizes and hashes, prompt.md and task.yaml
 * side by side, and the reference answer's changed values on the hidden panel. Compared
 * with itself (the first version), every file is listed as added. "Only fixtures changed"
 * says so up front.
 */
const props = withDefaults(
  defineProps<{
    diff: TaskDiff;
    /** When the newer side was loaded, for the header. */
    loadedAt?: string | null;
    /** The newer side failed its self-check. */
    toInvalid?: boolean;
    back: RouteLocationRaw;
  }>(),
  { loadedAt: null, toInvalid: false },
);

type Change = TaskFileChange['change'];
interface FileRow {
  path: string;
  change: Change;
  size: string;
  from: string | null;
  to: string | null;
}

const MARK: Record<Change, string> = {
  changed: 'bg-run-soft text-run-text',
  added: 'bg-pass-soft text-pass-text',
  removed: 'bg-fail-soft text-fail-text',
  unchanged: 'bg-que-soft text-que-text',
};

/** The first version, shown against itself: nothing to compare, every file is new. */
const firstVersion = computed(() => props.diff.from.suiteId === props.diff.to.suiteId);
const fromLabel = computed(() => `v${props.diff.from.taskVersion}`);
const toLabel = computed(() => `v${props.diff.to.taskVersion}`);

const textChanged = (lines: TextDiffLine[]): boolean => lines.some((l) => l.kind !== 'same');

/** prompt.md, task.yaml and reference.json live on the task row: no size or hash here. */
const files = computed<FileRow[]>(() => {
  const d = props.diff;
  const own = (path: string, changed: boolean): FileRow => ({
    path,
    change: firstVersion.value ? 'added' : changed ? 'changed' : 'unchanged',
    size: MISSING,
    from: null,
    to: null,
  });
  return [
    own('prompt.md', textChanged(d.prompt)),
    own('task.yaml', textChanged(d.taskYaml)),
    own('reference.json', d.reference.length > 0),
    ...d.files.map((f): FileRow => {
      const change: Change = firstVersion.value ? 'added' : f.change;
      const before = f.before ? formatBytes(f.before.sizeBytes) : null;
      const after = f.after ? formatBytes(f.after.sizeBytes) : null;
      return {
        path: f.path,
        change,
        size: change === 'changed' ? `${before} → ${after}` : (after ?? before ?? MISSING),
        from: change === 'changed' && f.before ? shortHash(f.before.sha256) : null,
        to: f.after ? shortHash(f.after.sha256) : f.before ? shortHash(f.before.sha256) : null,
      };
    }),
  ];
});

const changedCount = computed(() => files.value.filter((f) => f.change !== 'unchanged').length);
const countLine = computed(() => {
  if (firstVersion.value) return plural(files.value.length, 'file');
  const unchanged = files.value.length - changedCount.value;
  const changed = `${plural(changedCount.value, 'file')} changed`;
  return unchanged > 0 ? `${changed} · ${unchanged} unchanged` : changed;
});

const onlyFixtures = computed(
  () =>
    !firstVersion.value &&
    changedCount.value > 0 &&
    files.value.every((f) => f.change === 'unchanged' || f.path.startsWith('fixtures/')),
);
const identical = computed(() => !firstVersion.value && changedCount.value === 0);

const textDiffs = computed(() =>
  firstVersion.value
    ? []
    : [
        { path: 'prompt.md', lines: props.diff.prompt },
        { path: 'task.yaml', lines: props.diff.taskYaml },
      ]
        .filter((t) => textChanged(t.lines))
        .map((t) => ({ ...t, rows: sideBySide(t.lines), caption: diffCaption(t.lines) })),
);

const suitesLine = computed(() => {
  const d = props.diff;
  const when = props.loadedAt ? ` · ${formatDateTime(props.loadedAt)}` : '';
  return firstVersion.value
    ? `suite v${d.to.suiteVersion}${when}`
    : `suite v${d.from.suiteVersion} → suite v${d.to.suiteVersion}${when}`;
});

const foot = computed(() => {
  if (firstVersion.value) return 'Open a file from the task page to read it.';
  if (identical.value) return '';
  return `Results on ${fromLabel.value} and ${toLabel.value} are not comparable.`;
});
</script>

<template>
  <section
    class="overflow-hidden rounded-6 border border-border bg-surface"
    aria-label="Task diff"
    data-testid="task-diff"
  >
    <div
      class="flex flex-wrap items-center justify-between gap-10 border-b border-border px-14 py-12"
    >
      <div class="flex flex-wrap items-center gap-8">
        <span class="font-mono font-semibold">{{ diff.key }}</span>
        <template v-if="!firstVersion">
          <BaseTag>{{ fromLabel }}</BaseTag>
          <span class="text-text-3" aria-hidden="true">→</span>
        </template>
        <BaseTag strong>{{ toLabel }}</BaseTag>
        <span class="text-12 text-text-3">{{ suitesLine }}</span>
      </div>
      <span class="text-12 text-text-3" data-testid="diff-count">{{ countLine }}</span>
    </div>

    <div
      v-if="firstVersion || onlyFixtures || identical"
      role="status"
      class="mx-14 mt-12 flex items-start gap-10 rounded-6 border border-border-strong bg-accent-soft px-12 py-10"
      data-testid="diff-notice"
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 16 16"
        aria-hidden="true"
        class="mt-2 flex-none text-accent"
      >
        <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.5" />
        <path
          d="M8 7.2v4M8 4.8h.01"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
        />
      </svg>
      <span v-if="firstVersion"
        ><b>This is the first version of {{ diff.key }}.</b>
        <span class="text-text-2">
          There is no earlier version to compare with, so every file is listed as added.</span
        ></span
      >
      <span v-else-if="onlyFixtures"
        ><b>Only fixtures changed.</b>
        <span class="text-text-2">
          The prompt, task.yaml, the reference answer and the verifier script are the same as
          {{ fromLabel }}.<template v-if="toInvalid">
            The self-check on {{ toLabel }} failed.</template
          ></span
        ></span
      >
      <span v-else
        ><b>Nothing changed.</b>
        <span class="text-text-2">
          {{ diff.key }} has the same files in suite v{{ diff.from.suiteVersion }} and suite v{{
            diff.to.suiteVersion
          }}.</span
        ></span
      >
    </div>

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
              v-for="f in files"
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
              <td
                class="text-right font-mono text-12"
                :class="{ 'text-text-3': f.size === MISSING }"
              >
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

    <div v-for="t in textDiffs" :key="t.path" class="flex flex-col gap-6 px-14 pt-4 pb-12">
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
      v-if="!firstVersion && diff.reference.length"
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
        <div class="overflow-hidden rounded-4 border border-border bg-surface">
          <div class="grid grid-cols-2 font-mono text-12 leading-20">
            <div
              class="border-r border-b border-border bg-surface-2 px-10 py-4 text-11 text-text-2"
            >
              {{ fromLabel }}
            </div>
            <div class="border-b border-border bg-surface-2 px-10 py-4 text-11 text-text-2">
              {{ toLabel }}
            </div>
            <template v-for="entry in diff.reference" :key="entry.path">
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
        <span class="text-12 text-text-3">Never copied into a run. Only the checks read it.</span>
      </div>
    </div>

    <div
      class="flex flex-wrap items-center justify-between gap-x-16 gap-y-8 border-t border-border px-14 py-10"
    >
      <span class="text-12 text-text-3">{{ foot }}</span>
      <RouterLink class="btn sm" :to="back">Back to {{ diff.key }}</RouterLink>
    </div>
  </section>
</template>
