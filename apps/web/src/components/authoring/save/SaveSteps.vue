<script setup lang="ts">
import { SAVE_STEPS } from '@hermes-evals/shared';
import { computed } from 'vue';
import type { SaveStep } from '@/api/types/authoring';

/**
 * The steps of a save as the worker runs them (SaveSteps component, SA.11): writing the
 * files to a staging folder, loading it, the self-checks, then moving it into ./suites. Done
 * steps tick, the running one spins ("Self-checks 1 of 2…"), a failed one is marked with the
 * loader's line under it and the steps after it read "not run". The folder in ./suites
 * changes only at the last step.
 */
const props = withDefaults(
  defineProps<{
    state: 'progress' | 'done' | 'failed';
    /** The running step (progress) or the one that failed. */
    step?: SaveStep | null;
    selfChecks?: { done: number; total: number } | null;
    /** As shown: `./suites/invoices-v1/`. */
    folderPath: string;
    /** Under the failed step: "overdue_count/task.yaml line 9: unknown key prmary". */
    failure?: string | null;
  }>(),
  { step: null, selfChecks: null, failure: null },
);

type RowState = 'done' | 'run' | 'fail' | 'wait';

const at = computed(() => SAVE_STEPS.indexOf(props.step ?? 'staging'));

function label(step: SaveStep, state: RowState): string {
  if (step === 'staging')
    return state === 'run'
      ? 'Writing files to a staging folder…'
      : 'Writing files to a staging folder';
  if (step === 'loading') return state === 'run' ? 'Loading…' : 'Loading';
  if (step === 'self_checks') {
    const counts = props.selfChecks;
    if (state === 'run')
      return counts ? `Self-checks ${counts.done} of ${counts.total}…` : 'Self-checks…';
    if (state === 'done' && counts) return `Self-checks ${counts.total} of ${counts.total}`;
    return 'Self-checks';
  }
  return state === 'run' ? `Moving into ${props.folderPath}…` : `Moving into ${props.folderPath}`;
}

const rows = computed(() =>
  SAVE_STEPS.map((step, i) => {
    const state: RowState =
      props.state === 'done'
        ? 'done'
        : i < at.value
          ? 'done'
          : i > at.value
            ? 'wait'
            : props.state === 'failed'
              ? 'fail'
              : 'run';
    const notRun = props.state === 'failed' && state === 'wait';
    return {
      step,
      state,
      text: `${label(step, state)}${state === 'done' ? ' ✓' : ''}${notRun ? ' · not run' : ''}`,
      // Inside a code line already: the message's backticks go.
      detail: state === 'fail' && props.failure ? props.failure.split('`').join('') : null,
    };
  }),
);

const ICON: Record<RowState, string> = {
  done: 'size-14 rounded-full bg-pass',
  run: 'size-14 animate-spin rounded-full border-2 border-run-soft border-t-run',
  fail: 'size-14 rounded-3 bg-fail',
  wait: 'size-12 rounded-full border-[1.5px] border-border-strong',
};
const LABEL: Record<RowState, string> = {
  done: '',
  run: 'font-medium',
  fail: 'font-semibold text-fail-text',
  wait: 'text-text-3',
};
</script>

<template>
  <div
    class="flex flex-col gap-2 bg-surface"
    role="list"
    aria-label="Saving steps"
    aria-live="polite"
    data-testid="save-steps"
  >
    <div
      v-for="row in rows"
      :key="row.step"
      role="listitem"
      class="grid grid-cols-[20px_minmax(0,1fr)] items-start gap-8 py-6"
      :data-step="row.step"
      :data-state="row.state"
    >
      <span class="flex h-20 items-center justify-center"><span :class="ICON[row.state]" /></span>
      <span class="flex flex-col gap-2">
        <span :class="LABEL[row.state]">{{ row.text }}</span>
        <code v-if="row.detail" class="text-11 leading-16 text-fail-text">{{ row.detail }}</code>
      </span>
    </div>
  </div>
</template>
