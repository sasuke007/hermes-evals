<script setup lang="ts">
import { computed } from 'vue';
import { formatCount, formatSigned } from '@/lib/format';
import IntervalChart from './IntervalChart.vue';
import { intervalText, provisionalBasis, splitLead, statisticsReading } from './readings';
import type { ComparisonView } from '@/api/types/experiments';
import StatusChip from '@/components/ui/StatusChip.vue';

/**
 * The statistics panel (Comparison board): the verdict chip, the observed mean difference,
 * the 95% bootstrap interval and the number of resamples, the interval drawn on a number line,
 * and "How to read this" in plain words. Provisional while the experiment runs, is paused or
 * failed: a dashed panel and chip, and the line saying how many runs it rests on. Without
 * statistics (too few runs or tasks) it keeps its place and says why, in the API's words.
 */
const props = defineProps<{ view: ComparisonView }>();

const stats = computed(() => props.view.statistics);
const provisional = computed(() => props.view.provisional);
const chipStatus = computed(() =>
  provisional.value ? 'provisional' : (stats.value?.verdict ?? 'not_computable'),
);
const reading = computed(() => statisticsReading(props.view));
const unavailable = computed(() =>
  props.view.statisticsUnavailable ? splitLead(props.view.statisticsUnavailable.message) : null,
);

const deltaClass = computed(() => {
  switch (stats.value?.verdict) {
    case 'better':
      return 'text-pass-text';
    case 'worse':
      return 'text-fail-text';
    case 'provisional':
      return 'text-text-2';
    default:
      return '';
  }
});

const chartLabel = computed(() => {
  const s = stats.value;
  if (!s || !provisional.value) return null;
  return `Provisional: difference ${formatSigned(s.observedDelta)}, 95% interval ${formatSigned(s.lo)} to ${formatSigned(s.hi)}, from ${props.view.progress.scored} of ${props.view.progress.total} runs`;
});
</script>

<template>
  <section
    class="flex flex-col gap-16 rounded-6 border bg-surface p-20"
    :class="provisional ? 'border-dashed border-border-strong' : 'border-border'"
    aria-labelledby="cmp-stats"
    data-testid="statistics-panel"
    :data-verdict="chipStatus"
  >
    <div class="flex items-center justify-between gap-8">
      <h2 id="cmp-stats" class="text-15 font-semibold">Statistics</h2>
      <StatusChip
        v-if="chipStatus === 'provisional'"
        kind="verdict"
        status="provisional"
        :dot="false"
        >Provisional</StatusChip
      >
      <StatusChip v-else kind="verdict" :status="chipStatus" :dot="false" />
    </div>
    <template v-if="stats">
      <p v-if="provisional" class="-mt-6 font-medium">{{ provisionalBasis(view) }}</p>
      <dl class="grid grid-cols-3 gap-12">
        <div>
          <dt class="text-12 text-text-3">Observed mean difference</dt>
          <dd class="text-20 font-semibold" :class="deltaClass" data-testid="observed-delta">
            {{ formatSigned(stats.observedDelta) }}
          </dd>
        </div>
        <div>
          <dt class="text-12 text-text-3">
            {{ Math.round(stats.confidence * 100) }}% bootstrap interval
          </dt>
          <dd class="font-mono text-20 font-semibold" data-testid="interval">
            {{ intervalText(stats.lo, stats.hi) }}
          </dd>
        </div>
        <div>
          <dt class="text-12 text-text-3">Bootstrap resamples</dt>
          <dd class="text-20 font-semibold">{{ formatCount(stats.resamples) }}</dd>
        </div>
      </dl>
      <IntervalChart
        :lo="stats.lo"
        :hi="stats.hi"
        :point="stats.observedDelta"
        :verdict="provisional ? 'provisional' : stats.verdict"
        :label="chartLabel"
      />
      <div v-if="reading" class="flex flex-col gap-8 border-t pt-12">
        <h3 class="text-13 font-semibold">How to read this</h3>
        <p class="text-pretty text-text-2">{{ reading.read1 }}</p>
        <p class="text-pretty text-text-2">{{ reading.read2 }}</p>
      </div>
    </template>
    <p v-else-if="unavailable" class="text-text-2" data-testid="statistics-unavailable">
      <b class="font-semibold text-text">{{ unavailable.lead }}</b>
      {{ unavailable.rest }}
    </p>
  </section>
</template>
