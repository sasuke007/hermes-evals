<script setup lang="ts">
import { computed } from 'vue';
import ErrorBanner from '@/components/ui/ErrorBanner.vue';
import type { RunDetail } from '@/api/types/runs';
import ExecutionErrorPanel from './ExecutionErrorPanel.vue';
import RichSentence from './RichSentence.vue';
import ScoreTable from './ScoreTable.vue';
import SectionHeading from './SectionHeading.vue';

/**
 * Section 1, Outcome (RunInspector, RunInspectorStates): why the run has the result it has.
 * Scored: the score table, with the reason above it when a key is ungradable (amber) or its
 * scorer broke (violet, with the failed request). Execution error: the banner with the
 * category, the attempts and the stderr tail instead of scores. Not finished: a dashed note
 * that scores come later. Cancelled: a note that it is not scored and not counted.
 */
const props = defineProps<{ detail: RunDetail; sectionId: string }>();
const emit = defineEmits<{ seek: [seq: number] }>();

const status = computed(() => props.detail.status);
const notice = computed(() => props.detail.outcomeNotice);
/** "Key method · …" with the key in mono. */
const noticeDetail = computed(() => {
  const n = notice.value;
  return n ? n.detail.replace(`Key ${n.key}`, `Key \`${n.key}\``) : '';
});
const primaryKey = computed(() => props.detail.scores.find((s) => s.primary)?.key ?? null);
</script>

<template>
  <section
    :id="sectionId"
    aria-labelledby="ri-h-outcome"
    class="flex flex-col gap-10"
    data-testid="section-outcome"
  >
    <SectionHeading id="ri-h-outcome" :n="1" title="Outcome">
      <span
        v-if="status === 'scored' && detail.attemptCount > 1"
        class="text-12 font-normal text-text-3"
        >attempt {{ detail.shownAttempt }}</span
      >
    </SectionHeading>

    <template v-if="status === 'execution_error' && detail.executionError">
      <ExecutionErrorPanel
        :error="detail.executionError"
        :attempts="detail.attempts"
        :shown-attempt="detail.shownAttempt"
        :budget-s="detail.limits.budgetS"
      />
    </template>

    <div
      v-else-if="status === 'cancelled'"
      class="rounded-6 border border-border bg-surface-2 px-14 py-12 text-text-2"
      data-testid="outcome-note"
    >
      No scores. Cancelled runs are not scored and do not count toward pass rates or the interval.
    </div>

    <div
      v-else-if="status !== 'scored' || !detail.scores.length"
      class="rounded-6 border border-dashed border-border-strong bg-surface px-14 py-12 text-text-2"
      data-testid="outcome-note"
    >
      <template v-if="status === 'executed' || status === 'scoring'">
        Not scored yet. Execution finished; scores appear here when the scorers for this task
        complete.
      </template>
      <template v-else-if="status === 'execution_error'"> Not scored: execution failed. </template>
      <template v-else>
        Not scored yet. Scores appear here when execution finishes and the scorers for this task
        complete.
      </template>
    </div>

    <template v-else>
      <ErrorBanner
        v-if="notice?.kind === 'ungradable'"
        tone="warning"
        :title="notice.title"
        data-testid="outcome-notice"
      >
        <span class="text-text-2"><RichSentence :text="noticeDetail" /></span>
      </ErrorBanner>
      <ErrorBanner
        v-else-if="notice?.kind === 'error'"
        tone="violet"
        :title="notice.title"
        data-testid="outcome-notice"
      >
        <code v-if="notice.request" class="break-all text-text-2">{{ notice.request }}</code>
        <span class="text-12 text-text-3"><RichSentence :text="noticeDetail" /></span>
      </ErrorBanner>
      <ScoreTable :scores="detail.scores" @seek="emit('seek', $event)" />
      <p v-if="detail.scores.length > 1 && primaryKey" class="text-12 text-text-3">
        Each check is scored on its own; there is no combined total. The primary check,
        <code class="font-mono">{{ primaryKey }}</code
        >, is this run's result.
      </p>
    </template>
  </section>
</template>
