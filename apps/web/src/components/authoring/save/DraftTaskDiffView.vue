<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink } from 'vue-router';
import type { DraftTaskDiff } from '@/api/types/authoring';
import type { TextDiffLine } from '@/api/types/suites';
import { diffFileRows, fileCountLine } from '@/components/suites/diffFiles';
import TaskDiffBody from '@/components/suites/TaskDiffBody.vue';
import BaseTag from '@/components/ui/BaseTag.vue';
import { draftTaskLocation } from '@/views/suites/authoringRoutes';
import { hhmm } from '@/components/suites/authoringFormat';

/**
 * A draft task against its base version, bare inside a Changes row of Review and save
 * (TaskDiff board, states "draft" and "new task"): the files with sizes and hashes, each
 * changed text side by side, the reference answer when it changed, and a way to the editor.
 * A task new in the draft lists every file as added.
 */
const props = defineProps<{ diff: DraftTaskDiff; folder: string }>();

const isNew = computed(() => props.diff.from === null);
const fromLabel = computed(() => (props.diff.from ? `v${props.diff.from.taskVersion}` : '—'));
const changed = (lines: readonly TextDiffLine[]): boolean => lines.some((l) => l.kind !== 'same');

const rows = computed(() =>
  diffFileRows({
    files: props.diff.files,
    prompt: props.diff.prompt,
    taskYaml: props.diff.taskYaml,
    referenceChanged: props.diff.reference.length > 0 || changed(props.diff.referenceText),
    allAdded: isNew.value,
  }),
);
const countLine = computed(() => fileCountLine(rows.value, isNew.value ? 'new' : 'diff'));
const suitesLine = computed(() =>
  props.diff.from
    ? `suite v${props.diff.from.suiteVersion} → draft · last edit ${hhmm(props.diff.updatedAt)}`
    : `added to the draft · ${hhmm(props.diff.updatedAt)}`,
);
const texts = computed(() =>
  [
    { path: 'prompt.md', lines: props.diff.prompt },
    { path: 'task.yaml', lines: props.diff.taskYaml },
  ]
    .filter((t) => changed(t.lines))
    .concat(props.diff.textFiles),
);
const foot = computed(() => {
  const d = props.diff;
  if (isNew.value || !changed(d.prompt)) return '';
  if (!changed(d.taskYaml) && !changed(d.referenceText) && d.reference.length === 0) {
    return 'The reference answer and the checks are unchanged. Run a self-check in the editor if the new prompt changes what a correct answer is.';
  }
  return '';
});
</script>

<template>
  <section
    class="overflow-hidden rounded-6 border border-border bg-surface"
    aria-label="TaskDiff"
    data-testid="draft-task-diff"
  >
    <div
      class="flex flex-wrap items-center justify-between gap-10 border-b border-border px-14 py-12"
    >
      <div class="flex flex-wrap items-center gap-8">
        <span class="font-mono font-semibold">{{ diff.key }}</span>
        <template v-if="!isNew">
          <BaseTag>{{ fromLabel }}</BaseTag>
          <span class="text-text-3" aria-hidden="true">→</span>
        </template>
        <BaseTag strong>draft</BaseTag>
        <span class="text-12 text-text-3">{{ suitesLine }}</span>
      </div>
      <span class="text-12 text-text-3" data-testid="diff-count">{{ countLine }}</span>
    </div>
    <TaskDiffBody
      :rows="rows"
      :from-label="fromLabel"
      to-label="draft"
      :texts="texts"
      :reference="diff.reference"
      :reference-text="diff.referenceText"
    />
    <div
      class="flex flex-wrap items-center justify-between gap-x-16 gap-y-8 border-t border-border px-14 py-10"
    >
      <span class="text-12 text-text-3">{{ foot }}</span>
      <RouterLink class="btn sm" :to="draftTaskLocation(folder, diff.key)"
        >Open in the editor</RouterLink
      >
    </div>
  </section>
</template>
