<script setup lang="ts">
import { computed } from 'vue';
import { EXECUTION_ERROR_CATEGORIES } from '@hermes-evals/shared';
import CopyButton from '@/components/ui/CopyButton.vue';
import type { AttemptView, ExecutionErrorView } from '@/api/types/runs';
import { formatClock, formatCount } from '@/lib/format';
import AttemptsTable from './AttemptsTable.vue';

/**
 * Outcome of a run that produced no answer (RunInspectorStates › Execution error): the
 * violet banner with every category and the run's one filled in, what the agent was doing,
 * the attempts table, and the stderr tail with Copy. A timeout adds the line saying when
 * the platform stopped it.
 */
const props = defineProps<{
  error: ExecutionErrorView;
  attempts: AttemptView[];
  shownAttempt: number;
  /** The run's time budget, for the timeout line. */
  budgetS: number;
}>();

const shown = computed(() => props.attempts.find((a) => a.number === props.shownAttempt) ?? null);
const lines = computed(() => props.error.stderrTail.lines);

/** "10:51:30 Stopped by the platform at 310 s (300 s budget + grace)." for a timeout. */
const stop = computed(() => {
  const attempt = shown.value;
  if (props.error.category !== 'timeout' || !attempt || attempt.durationS === null) return null;
  const at = Date.parse(attempt.startedAt) + attempt.durationS * 1000;
  const seconds = Math.round(attempt.durationS);
  const budget =
    seconds > props.budgetS ? `${props.budgetS} s budget + grace` : `${props.budgetS} s budget`;
  return {
    clock: Number.isNaN(at) ? null : formatClock(at),
    text: `Stopped by the platform at ${seconds} s (${budget}).`,
  };
});
</script>

<template>
  <div
    role="alert"
    class="flex flex-col gap-10 rounded-6 border border-err bg-err-soft p-14"
    data-testid="execution-error"
  >
    <div class="flex flex-wrap items-center gap-8">
      <b class="text-err-text">Not scored: execution failed</b>
      <span class="text-12 text-text-3">category</span>
      <span
        v-for="category in EXECUTION_ERROR_CATEGORIES"
        :key="category"
        class="chip"
        :class="
          category === error.category
            ? 'bg-err font-semibold text-on-accent'
            : 'bg-surface text-text-3 inset-ring inset-ring-border'
        "
        :aria-current="category === error.category ? 'true' : undefined"
        :data-current="category === error.category ? 'true' : undefined"
        >{{ category }}</span
      >
    </div>
    <p v-if="error.explanation" class="text-text-2">{{ error.explanation }}</p>
  </div>
  <AttemptsTable v-if="attempts.length" :attempts="attempts" :shown="shownAttempt" />
  <div class="flex flex-col gap-4">
    <div class="flex items-center justify-between gap-8">
      <span class="text-12 text-text-3" data-testid="stderr-caption">
        <template v-if="lines.length">
          stderr · last {{ formatCount(lines.length) }} of
          {{ formatCount(Math.max(error.stderrTail.totalLines, lines.length)) }}
          {{ error.stderrTail.totalLines === 1 ? 'line' : 'lines' }}
        </template>
        <template v-else>stderr · nothing written</template>
      </span>
      <CopyButton
        v-if="lines.length"
        variant="button"
        :text="lines.join('\n')"
        label="Copy the stderr tail"
        button-text="Copy"
      />
    </div>
    <pre
      v-if="lines.length"
      class="overflow-auto rounded-4 border border-border bg-surface px-12 py-10 font-mono text-12 leading-18 break-words whitespace-pre-wrap text-text"
      aria-label="stderr tail"
      data-testid="stderr-tail"
      >{{ lines.join('\n') }}</pre>
    <div
      v-if="stop"
      class="flex flex-wrap items-center gap-8 rounded-4 border border-dashed border-err px-12 py-8 text-12 text-err-text"
      data-testid="stop-line"
    >
      <span v-if="stop.clock" class="font-mono">{{ stop.clock }}</span>
      <b>{{ stop.text }}</b>
    </div>
  </div>
</template>
