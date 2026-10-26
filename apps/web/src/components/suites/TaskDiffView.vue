<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink, type RouteLocationRaw } from 'vue-router';
import type { TaskDiff, TextDiffLine } from '@/api/types/suites';
import BaseTag from '@/components/ui/BaseTag.vue';
import { formatDateTime } from '@/lib/format';
import { diffFileRows, fileCountLine } from './diffFiles';
import TaskDiffBody from './TaskDiffBody.vue';

/**
 * A task's changes from one version to the next (TaskDiff board, plan 4.5): the file list
 * marked changed, added, removed or unchanged with sizes and hashes (prompt.md, task.yaml and
 * reference.json first), prompt.md, task.yaml and each changed small text fixture side by
 * side, and the reference answer's changed values on the hidden panel. Compared with itself
 * (the first version), every file is listed as added. "Only fixtures changed" says so up
 * front.
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

/** The first version, shown against itself: nothing to compare, every file is new. */
const firstVersion = computed(() => props.diff.from.suiteId === props.diff.to.suiteId);
const fromLabel = computed(() => `v${props.diff.from.taskVersion}`);
const toLabel = computed(() => `v${props.diff.to.taskVersion}`);

const textChanged = (lines: TextDiffLine[]): boolean => lines.some((l) => l.kind !== 'same');

const files = computed(() =>
  diffFileRows({
    files: props.diff.files,
    prompt: props.diff.prompt,
    taskYaml: props.diff.taskYaml,
    referenceChanged: props.diff.reference.length > 0,
    allAdded: firstVersion.value,
  }),
);

const changedCount = computed(() => files.value.filter((f) => f.change !== 'unchanged').length);
const countLine = computed(() =>
  fileCountLine(files.value, firstVersion.value ? 'listing' : 'diff'),
);

const onlyFixtures = computed(
  () =>
    !firstVersion.value &&
    changedCount.value > 0 &&
    files.value.every((f) => f.change === 'unchanged' || f.path.startsWith('fixtures/')),
);
const identical = computed(() => !firstVersion.value && changedCount.value === 0);

/** prompt.md and task.yaml when they changed, then each changed small text fixture. */
const texts = computed(() =>
  firstVersion.value
    ? []
    : [
        { path: 'prompt.md', lines: props.diff.prompt },
        { path: 'task.yaml', lines: props.diff.taskYaml },
      ]
        .filter((t) => textChanged(t.lines))
        .concat(props.diff.textFiles),
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

    <TaskDiffBody
      :rows="files"
      :from-label="fromLabel"
      :to-label="toLabel"
      :texts="texts"
      :reference="firstVersion ? [] : diff.reference"
    />

    <div
      class="flex flex-wrap items-center justify-between gap-x-16 gap-y-8 border-t border-border px-14 py-10"
    >
      <span class="text-12 text-text-3">{{ foot }}</span>
      <RouterLink class="btn sm" :to="back">Back to {{ diff.key }}</RouterLink>
    </div>
  </section>
</template>
