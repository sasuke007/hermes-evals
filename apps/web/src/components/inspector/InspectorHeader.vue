<script setup lang="ts">
import { computed, ref } from 'vue';
import BaseTag from '@/components/ui/BaseTag.vue';
import ErrorBanner from '@/components/ui/ErrorBanner.vue';
import StatusChip from '@/components/ui/StatusChip.vue';
import type { RunDetail } from '@/api/types/runs';
import { MISSING, formatClock, formatDuration, formatDateTimeSeconds } from '@/lib/format';
import AttemptsTable from './AttemptsTable.vue';
import RunActions from './RunActions.vue';
import {
  formatElapsed,
  formatRunCost,
  formatTokensInOut,
  modelCallTokens,
} from './inspectorFormat';

/**
 * The drawer's sticky header under InspectorNav (RunInspector, RunInspectorStates): the task
 * with its version, the configuration, repetition and attempt, the run status and the
 * primary result; the figures that fit the status (duration, tokens, cost, finished; tokens
 * so far, budget and turn while running; how long it ran and who cancelled it); the actions;
 * an execution error's category and one-line reason; a re-score in flight or failed; earlier
 * attempts behind "Attempts (n)"; and the links to the five sections.
 */
const props = defineProps<{
  detail: RunDetail;
  /** When the detail arrived and now (epoch ms), for a live run's elapsed time. */
  loadedAt: number;
  now: number;
}>();
const emit = defineEmits<{ jump: [runId: string]; section: [key: string] }>();

const d = computed(() => props.detail);
const live = computed(() => d.value.status === 'running' && d.value.live !== null);
const multi = computed(() => d.value.attemptCount > 1);

const repTag = computed(() => {
  if (d.value.shownAttempt === 0) return `rep ${d.value.repetition} · not started`;
  const of = multi.value ? ` of ${d.value.attemptCount}` : '';
  return `rep ${d.value.repetition} · attempt ${d.value.shownAttempt}${of}`;
});
const elapsed = computed(() =>
  d.value.live
    ? formatElapsed(d.value.live.elapsedS + Math.max(0, props.now - props.loadedAt) / 1000)
    : '',
);

const tokens = computed(() => {
  const t = d.value.tokens ?? (live.value ? modelCallTokens(d.value.timeline.events) : null);
  return t ? formatTokensInOut(t) : MISSING;
});
const duration = computed(() => {
  const s = d.value.durationS;
  if (s === null) return MISSING;
  if (!d.value.durationIsBudget) return formatDuration(s);
  const budget = d.value.limits.budgetS;
  return Math.round(s) > budget
    ? `stopped at ${Math.round(s)} s (${budget} s budget + grace)`
    : `${Math.round(s)} s (budget)`;
});

interface Figure {
  label: string;
  value: string;
  note?: string;
}
const figures = computed<Figure[]>(() => {
  const r = d.value;
  const cost = { label: 'Est. cost', value: formatRunCost(r.costUsd) };
  switch (r.status) {
    case 'queued':
      return [{ label: 'Budget', value: `${r.limits.budgetS} s · ${r.limits.maxTurns} turns` }];
    case 'running':
      return [
        { label: 'Tokens so far', value: tokens.value },
        { label: 'Budget', value: `${r.limits.budgetS} s · ${r.limits.maxTurns} turns` },
        { label: 'Turn', value: r.live ? `${r.live.turn} of ${r.limits.maxTurns}` : MISSING },
      ];
    case 'cancelled':
      return [
        { label: 'Ran for', value: formatDuration(r.cancelled?.ranForS ?? r.durationS) },
        { label: 'Tokens', value: tokens.value },
        {
          label: 'Cancelled',
          value: r.cancelled
            ? `${r.cancelled.by === 'experiment' ? 'by experiment cancel' : 'by user'}, ${formatClock(r.cancelled.at)}`
            : MISSING,
        },
      ];
    case 'execution_error':
      return [
        { label: 'Duration', value: duration.value },
        { label: 'Tokens', value: tokens.value },
        cost,
      ];
    default:
      return [
        {
          label: 'Duration',
          value: duration.value,
          note: multi.value ? `(attempt ${r.shownAttempt})` : undefined,
        },
        { label: 'Tokens', value: tokens.value },
        cost,
        { label: 'Finished', value: formatDateTimeSeconds(r.finishedAt) },
      ];
  }
});

const pending = computed(() => {
  const p = d.value.evaluation.pending;
  return p && p.cause === 'rescore' ? p : null;
});
const failure = computed(() => d.value.evaluation.lastFailure);

const attemptsOpen = ref(false);
const earlier = computed(() => d.value.attempts.filter((a) => a.number < d.value.shownAttempt));
const earlierSummary = computed(() =>
  earlier.value
    .map((a) => `attempt ${a.number} ${a.status}${a.category ? ` · ${a.category}` : ''}`)
    .join(', '),
);

const message = ref<{ tone: 'done' | 'failed'; text: string } | null>(null);

const SECTIONS = [
  ['outcome', 'Outcome'],
  ['timeline', 'Timeline'],
  ['final', 'Final response'],
  ['artifacts', 'Artifacts'],
  ['launch', 'Launch record'],
] as const;
</script>

<template>
  <div class="flex flex-wrap items-end justify-between gap-12">
    <div class="flex min-w-0 flex-col gap-6">
      <div class="flex flex-wrap items-center gap-10">
        <h1 id="ri-title" class="font-mono text-20 font-semibold">{{ d.task.key }}</h1>
        <span class="-ml-4 font-mono text-14 font-medium text-text-2" title="Task version"
          >v{{ d.task.version }}</span
        >
        <span class="font-mono font-semibold">{{ d.configuration.name }}</span>
        <BaseTag>{{ repTag }}</BaseTag>
        <StatusChip kind="run" :status="d.status" data-testid="run-status">
          <template v-if="d.status === 'execution_error' && d.executionError"
            >execution_error · {{ d.executionError.category }}</template
          >
        </StatusChip>
        <StatusChip
          v-if="d.status === 'scored' && d.primary.status"
          kind="score"
          :status="d.primary.status"
          data-testid="run-result"
          >{{ d.primary.key }} {{ d.primary.status }}</StatusChip
        >
        <span v-if="live" class="font-mono text-12 text-text-2" data-testid="elapsed"
          >{{ elapsed }} elapsed</span
        >
      </div>
      <dl class="m-0 flex flex-wrap gap-x-24 gap-y-4 text-text-2" data-testid="run-figures">
        <div v-for="f in figures" :key="f.label" class="flex gap-6">
          <dt>{{ f.label }}</dt>
          <dd class="m-0 font-medium text-text">
            {{ f.value
            }}<span v-if="f.note" class="ml-4 text-12 font-normal text-text-3">{{ f.note }}</span>
          </dd>
        </div>
      </dl>
    </div>
    <RunActions
      :detail="d"
      @jump="emit('jump', $event)"
      @done="message = { tone: 'done', text: $event }"
      @failed="message = { tone: 'failed', text: $event }"
    />
  </div>

  <div
    v-if="d.status === 'execution_error' && d.executionError"
    class="flex items-start gap-8"
    data-testid="execution-reason"
  >
    <span class="mt-7 size-6 flex-none rounded-full bg-err" aria-hidden="true" />
    <span
      ><b class="text-err-text">{{ d.executionError.reason }}</b
      ><template v-if="d.executionError.meta"
        >{{ ' ' }}<span class="text-12 text-text-3">{{ d.executionError.meta }}</span></template
      ></span
    >
  </div>

  <p
    v-if="pending"
    class="flex flex-wrap items-center gap-8 text-12 text-text-2"
    data-testid="rescore-pending"
  >
    <StatusChip kind="evaluation" :status="pending.status" size="sm" />
    Re-score {{ pending.status }} · generation {{ pending.generation }}. The scores below are
    generation {{ d.evaluation.generation ?? MISSING }} until it publishes.
  </p>
  <p v-else-if="failure" class="text-12 text-ung-text" data-testid="rescore-failed">
    Re-score generation {{ failure.generation }} failed: {{ failure.error }}. The scores below are
    still generation {{ d.evaluation.generation ?? MISSING }}.
  </p>

  <ErrorBanner
    v-if="message?.tone === 'failed'"
    compact
    title="The action was refused"
    :detail="message.text"
    data-testid="action-error"
  />
  <p v-else-if="message" role="status" class="text-12 text-text-2" data-testid="action-done">
    {{ message.text }}
  </p>

  <div
    v-if="d.status !== 'execution_error' && earlier.length"
    class="flex flex-col gap-8 border-t border-border pt-8"
  >
    <button
      type="button"
      class="inline-flex cursor-pointer items-center gap-8 self-start border-0 bg-transparent p-0 text-12 font-medium text-text-2"
      :aria-expanded="attemptsOpen"
      data-testid="attempts-toggle"
      @click="attemptsOpen = !attemptsOpen"
    >
      <svg
        width="12"
        height="12"
        viewBox="0 0 12 12"
        aria-hidden="true"
        :class="{ 'rotate-90': attemptsOpen }"
      >
        <path
          d="M4 2.5L7.5 6 4 9.5"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
        />
      </svg>
      Attempts ({{ d.attempts.length }})
      <span class="font-normal text-text-3">· {{ earlierSummary }}</span>
    </button>
    <AttemptsTable v-if="attemptsOpen" :attempts="d.attempts" :shown="d.shownAttempt" />
  </div>

  <nav aria-label="Sections" class="flex flex-wrap gap-16 text-12">
    <a
      v-for="[key, label] in SECTIONS"
      :key="key"
      :href="`#ri-${key}`"
      @click.prevent="emit('section', key)"
      >{{ label }}</a
    >
  </nav>
</template>
