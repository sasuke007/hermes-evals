<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink } from 'vue-router';
import type { ExperimentDetail, ExperimentFailureView } from '@/api/types/experiments';
import ErrorBanner from '@/components/ui/ErrorBanner.vue';
import { formatUsd, plural } from '@/lib/format';
import { toneVars } from '@/lib/statusTones';

/**
 * A failed experiment (ExperimentStates › experiment failed): the circuit breaker stopped it
 * after N failed attempts in a row. The violet banner names the category, the cause and the
 * first stderr line with where to fix it; under it what ran and what still waits, and what
 * "Retry failed runs" (in the header) does.
 *
 * The breaker counts failed attempts, automatic retries included (plan 7.3: retries spend
 * too), so the run counts can show fewer execution errors than the threshold while the
 * retried runs wait in the queue. The legend puts the failed-attempt count (the threshold it
 * reached) beside the execution_error count, and says why they differ when they do (Phase 5
 * question 15). Copy no board draws beyond the banner's title.
 */
const props = defineProps<{ detail: ExperimentDetail; failure: ExperimentFailureView }>();

const counts = computed(() => props.detail.counts);
const title = computed(
  () =>
    `Stopped after ${props.failure.threshold} failed attempts in a row (${props.failure.category}): ${props.failure.message}`,
);
const identical = computed(() => {
  const f = props.failure;
  if (f.stderrFirstLine === null) return null;
  return f.identicalIn >= f.threshold
    ? `first line of stderr, identical in all ${f.threshold} runs`
    : `first line of stderr, identical in ${f.identicalIn} of ${f.threshold} runs`;
});
const hatch = computed(() => {
  const v = toneVars('que');
  return { background: `repeating-linear-gradient(135deg, ${v.solid} 0 2px, ${v.soft} 2px 4px)` };
});
</script>

<template>
  <section
    class="flex flex-col gap-12 rounded-6 border border-border bg-surface px-20 pt-16 pb-20"
    aria-label="Experiment failed"
    data-testid="failed-panel"
  >
    <ErrorBanner tone="violet" :title="title" :detail="failure.stderrFirstLine">
      <template v-if="identical || failure.fix" #hint>
        <template v-if="identical">{{ identical }}</template
        ><template v-if="identical && failure.fix"> · </template
        ><RouterLink v-if="failure.fix" :to="failure.fix.to">{{ failure.fix.label }}</RouterLink>
      </template>
    </ErrorBanner>
    <div class="flex flex-wrap items-center gap-28">
      <span class="inline-flex items-center gap-8" data-testid="failed-attempts"
        ><span class="size-10 rounded-2 border-[1.5px] border-err" aria-hidden="true" /><span
          class="text-12"
          >failed attempts in a row</span
        ><b>{{ failure.threshold }}</b></span
      >
      <span class="inline-flex items-center gap-8" data-testid="execution-errors"
        ><span class="size-10 rounded-2 bg-err" aria-hidden="true" /><span class="font-mono text-12"
          >execution_error</span
        ><b>{{ counts.execution_error }}</b></span
      >
      <span class="inline-flex items-center gap-8"
        ><span class="size-10 rounded-2" :style="hatch" aria-hidden="true" /><span
          class="font-mono text-12"
          >queued</span
        ><b>{{ counts.queued }}</b></span
      >
      <span class="text-12 text-text-3"
        >{{ counts.scored }} scored · spend {{ formatUsd(detail.spend.spentUsd) }}</span
      >
    </div>
    <p class="text-12 text-text-3">
      The stop threshold is configurable (<code>max_consecutive_execution_errors</code>, default
      14).
      <template v-if="counts.execution_error < failure.threshold"
        >Automatic retries count as failed attempts, so fewer runs end in
        <code>execution_error</code> than attempts failed: the retried ones are queued.</template
      >
      <template v-if="failure.category === 'setup'"
        >A setup error usually needs a fix before retrying: retrying unchanged would fail the same
        way.</template
      >
      "Retry failed runs" re-queues the {{ plural(counts.execution_error, 'errored run') }} and
      resumes the {{ counts.queued }} queued ones.
    </p>
  </section>
</template>
