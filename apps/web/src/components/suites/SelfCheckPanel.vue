<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink, type RouteLocationRaw } from 'vue-router';
import type { SelfCheckFailureView, TaskSelfCheckView } from '@/api/types/suites';
import BasePanel from '@/components/ui/BasePanel.vue';
import { formatDateTime, formatRate, MISSING } from '@/lib/format';
import { TONE_CLASSES, type Tone } from '@/lib/statusTones';

/**
 * How the task's checks did on its own reference answer at the last load (TaskDetail
 * board): the overall result, when it ran, each key's status, score and note, and for a
 * failure the captured output, the same as on Suite detail.
 */
const props = withDefaults(
  defineProps<{
    selfCheck: TaskSelfCheckView;
    failure?: SelfCheckFailureView | null;
    taskKey: string;
    /** "Same output as on Suite detail" links here. */
    suiteTo: RouteLocationRaw;
  }>(),
  { failure: null },
);

const TONES: Record<string, Tone> = {
  passed: 'pass',
  failed: 'fail',
  error: 'err',
  ungradable: 'ung',
  skipped: 'que',
};
const chip = (status: string): string => (TONES[status] ? TONE_CLASSES[TONES[status]!].chip : '');

const failed = computed(
  () => props.selfCheck.status === 'failed' || props.selfCheck.status === 'error',
);
const overall = computed(() =>
  failed.value
    ? { label: 'failed', classes: TONE_CLASSES.fail.chip }
    : props.selfCheck.status === 'skipped'
      ? { label: 'skipped', classes: TONE_CLASSES.que.chip }
      : { label: 'passed', classes: TONE_CLASSES.pass.chip },
);
const when = computed(() => {
  const ran = `Ran ${formatDateTime(props.selfCheck.ranAt)} on ${props.selfCheck.trigger}.`;
  const previous = props.failure?.previousRun;
  return previous
    ? `${ran} Previous run ${formatDateTime(previous.at)} ${previous.status}.`
    : `${ran} Each check is scored against the reference answer.`;
});
</script>

<template>
  <BasePanel aria-labelledby="task-self-check">
    <template #header>
      <div class="flex items-center justify-between gap-10 border-b border-border px-16 py-12">
        <h2 id="task-self-check" class="text-15 font-semibold">Self-check</h2>
        <span class="chip" :class="overall.classes" data-testid="self-check-status">{{
          overall.label
        }}</span>
      </div>
    </template>
    <div class="flex flex-col gap-8 px-16 py-12">
      <p class="text-12 text-text-3">{{ when }}</p>
      <div
        v-for="r in selfCheck.results"
        :key="r.key"
        class="flex flex-col gap-2"
        :data-result="r.key"
      >
        <div class="flex justify-between gap-8">
          <span class="font-mono">{{ r.key }}</span>
          <span class="inline-flex items-center gap-6 text-right">
            <span class="chip" :class="chip(r.status)">{{ r.status }}</span>
            <span class="font-mono">{{
              r.score !== null ? formatRate(r.score, 2) : r.status === 'skipped' ? '' : MISSING
            }}</span>
          </span>
        </div>
        <span v-if="r.note" class="text-12 text-text-3">{{ r.note }}</span>
      </div>
      <template v-if="failed && failure">
        <pre
          class="rounded-4 border border-border bg-surface-2 px-12 py-10 font-mono text-11 leading-16 whitespace-pre-wrap"
          data-testid="self-check-transcript"
          >{{ failure.transcript }}</pre>
        <p class="text-12 text-text-3">
          Same output as on <RouterLink :to="suiteTo">Suite detail</RouterLink>. Until this passes,
          <span class="font-mono">{{ taskKey }}</span> cannot be selected in a new experiment.
        </p>
      </template>
    </div>
  </BasePanel>
</template>
