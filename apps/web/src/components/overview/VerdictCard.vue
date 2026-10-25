<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink, type RouteLocationRaw } from 'vue-router';
import type { ConfigAggregate, VerdictSummary } from '@/api/types/experiments';
import IntervalBar from '@/components/ui/IntervalBar.vue';
import StatusChip from '@/components/ui/StatusChip.vue';
import { formatCount, formatRate, formatSigned } from '@/lib/format';
import { ROUTE_NAMES } from '@/router';
import {
  costSentence,
  historyLine,
  intervalText,
  notComputableSentence,
  verdictSentence,
} from './overview';

/**
 * One candidate's verdict against the baseline, read top to bottom as a sentence: candidate
 * vs baseline, the verdict, by how much, how sure, and where it comes from.
 *   lg  the completed Overview with one candidate (OverviewComplete): 40px Δ, the full
 *       IntervalBar, pass rates with their counts, the task counts, the method, a sentence
 *       that reads the interval and the cost of acting on it.
 *   md  one card per candidate (Components 2 › VerdictCard and its states): 28px Δ, the small
 *       IntervalBar, pass rates and the task links.
 * States: better · worse · inconclusive · provisional (dashed card, "Provisional", the line
 * "Based on 87 of 120 runs scored so far…") · not computable (pass rates, no interval, why).
 * A recomputed verdict carries "Updated 23 Oct 14:20 after 1 retry · previously …" (Flow B).
 */
const props = withDefaults(
  defineProps<{
    verdict: VerdictSummary;
    experimentId: string;
    suiteName: string;
    size?: 'md' | 'lg';
    /** The provisional line: "Based on 87 of 120 runs scored so far. The interval will change." */
    provisionalLine?: string | null;
    /** The two configurations' aggregates, for the cost sentence (lg, better). */
    aggregates?: ConfigAggregate[];
    /** More than one candidate: links carry ?candidate=. */
    multiCandidate?: boolean;
  }>(),
  { size: 'md', provisionalLine: null, aggregates: () => [], multiCandidate: false },
);

const v = computed(() => props.verdict);
const lg = computed(() => props.size === 'lg');
const provisional = computed(() => v.value.verdict === 'provisional');
const hasInterval = computed(
  () => v.value.lo !== null && v.value.hi !== null && v.value.delta !== null,
);
const final = computed(() =>
  v.value.verdict === 'better' || v.value.verdict === 'worse' || v.value.verdict === 'inconclusive'
    ? v.value.verdict
    : 'provisional',
);
const deltaClass = computed(() => {
  switch (v.value.verdict) {
    case 'better':
      return 'text-pass-text';
    case 'worse':
      return 'text-fail-text';
    case 'inconclusive':
      return 'text-text';
    default:
      return 'text-text-2';
  }
});
const noInterval = computed(() =>
  notComputableSentence(v.value.reason ?? (provisional.value ? 'not_enough_runs' : null)),
);
const history = computed(() => historyLine(v.value.history));
const sentence = computed(() => (lg.value ? verdictSentence(v.value, props.suiteName) : null));
const cost = computed(() => {
  if (!lg.value || v.value.verdict !== 'better') return null;
  const of = (versionId: string) =>
    props.aggregates.find((a) => a.configuration.versionId === versionId);
  return costSentence(of(v.value.baseline.versionId), of(v.value.candidate.versionId));
});
const aria = computed(() =>
  provisional.value && hasInterval.value
    ? `Provisional: difference ${formatSigned(v.value.delta)}, 95% interval ${formatSigned(v.value.lo)} to ${formatSigned(v.value.hi)}`
    : null,
);

/** The Comparison tab's URL state: `candidate` (a version id) and `show` (its task filter). */
function comparison(show?: 'improved' | 'regressed' | 'unchanged'): RouteLocationRaw {
  const query: Record<string, string> = {};
  if (props.multiCandidate) query.candidate = v.value.candidate.versionId;
  if (show) query.show = show;
  return { name: ROUTE_NAMES.experimentComparison, params: { id: props.experimentId }, query };
}
const counts = computed(() => v.value.taskCounts);
const resamples = computed(() => `${formatCount(v.value.method.resamples)} resamples over tasks`);
</script>

<template>
  <article
    class="flex flex-col rounded-6 border bg-surface"
    :class="[
      lg ? 'gap-16 p-20' : 'gap-14 p-16',
      provisional ? 'border-dashed border-border-strong' : 'border-border',
    ]"
    :aria-label="`Verdict for ${v.candidate.name} against ${v.baseline.name}`"
    data-testid="verdict-card"
    :data-verdict="v.verdict"
  >
    <div class="flex flex-wrap items-center justify-between gap-12">
      <div class="flex min-w-0 flex-wrap items-baseline" :class="lg ? 'gap-x-8' : 'gap-x-6'">
        <span class="font-mono font-semibold wrap-anywhere" :class="{ 'text-15': lg }">{{
          v.candidate.name
        }}</span>
        <span class="text-text-3">vs</span>
        <span class="font-mono wrap-anywhere text-text-2" :class="{ 'text-15': lg }">{{
          v.baseline.name
        }}</span>
      </div>
      <StatusChip
        kind="verdict"
        :status="v.verdict"
        :dot="false"
        :class="{ 'h-24 px-10 text-13': lg }"
        data-testid="verdict-chip"
      >
        <template v-if="provisional" #default>Provisional</template>
      </StatusChip>
    </div>
    <p v-if="provisional && provisionalLine" class="-mt-6 text-12 leading-18 font-medium">
      {{ provisionalLine }}
    </p>

    <div
      v-if="v.delta !== null || !lg"
      class="flex flex-wrap items-baseline"
      :class="lg ? 'gap-14' : 'gap-12'"
    >
      <span
        v-if="v.delta !== null"
        class="font-semibold"
        :class="[deltaClass, lg ? 'text-[40px] leading-44 tracking-[-0.01em]' : 'text-28']"
        data-testid="verdict-delta"
        >{{ formatSigned(v.delta) }}</span
      >
      <span v-if="lg && hasInterval" class="text-text-2"
        >pass-rate difference · 95% interval
        <span class="font-mono text-text">{{ intervalText(v.lo, v.hi) }}</span></span
      >
      <span v-else-if="lg" class="text-text-2">pass-rate difference · no interval</span>
      <span v-else class="font-mono text-12 text-text-2">{{
        hasInterval ? `95% CI ${intervalText(v.lo, v.hi)}` : 'no interval'
      }}</span>
    </div>

    <IntervalBar
      v-if="hasInterval"
      :lo="v.lo!"
      :hi="v.hi!"
      :point="v.delta!"
      :verdict="final"
      :size="lg ? 'md' : 'sm'"
      :label="aria"
    />
    <div v-else class="rounded-4 border border-dashed border-border-strong px-10 py-8">
      <span class="text-12 leading-18 text-text-2" data-testid="no-interval">{{ noInterval }}</span>
    </div>

    <div
      class="grid border-y border-border"
      :class="lg ? 'grid-cols-4 gap-12 py-12 max-md:grid-cols-2' : 'grid-cols-2 gap-8 py-10'"
    >
      <div>
        <div class="text-12 text-text-3">
          Pass rate · <span class="font-mono">{{ v.baseline.name }}</span>
        </div>
        <div class="font-semibold" :class="lg ? 'text-17' : 'text-15'">
          {{ formatRate(v.passRates.baseline) }}
        </div>
        <div v-if="lg" class="text-12 text-text-3">
          {{ v.passCounts.baseline.passed }} / {{ v.passCounts.baseline.counted }} runs
        </div>
      </div>
      <div>
        <div class="text-12 text-text-3">
          Pass rate · <span class="font-mono">{{ v.candidate.name }}</span>
        </div>
        <div class="font-semibold" :class="lg ? 'text-17' : 'text-15'">
          {{ formatRate(v.passRates.candidate) }}
        </div>
        <div v-if="lg" class="text-12 text-text-3">
          {{ v.passCounts.candidate.passed }} / {{ v.passCounts.candidate.counted }} runs
        </div>
      </div>
      <template v-if="lg">
        <div>
          <div class="text-12 text-text-3">Tasks</div>
          <div class="flex gap-10 text-15 font-semibold">
            <RouterLink :to="comparison('improved')" class="text-pass-text hover:text-pass-text"
              >{{ counts.improved }} improved</RouterLink
            >
          </div>
          <div class="text-12 text-text-3">
            <RouterLink :to="comparison('regressed')">{{ counts.regressed }} regressed</RouterLink>
            ·
            <RouterLink :to="comparison('unchanged')">{{ counts.unchanged }} unchanged</RouterLink>
          </div>
        </div>
        <div>
          <div class="text-12 text-text-3">Method</div>
          <div class="font-medium">Paired bootstrap</div>
          <div class="text-12 text-text-3">{{ resamples }}</div>
        </div>
      </template>
    </div>

    <div v-if="!lg" class="flex flex-wrap gap-16">
      <RouterLink :to="comparison('improved')">{{ counts.improved }} improved</RouterLink>
      <RouterLink :to="comparison('regressed')">{{ counts.regressed }} regressed</RouterLink>
      <RouterLink :to="comparison('unchanged')">{{ counts.unchanged }} unchanged</RouterLink>
    </div>

    <div
      v-if="history"
      class="rounded-4 bg-surface-2 px-10 py-8 text-12"
      data-testid="verdict-history"
    >
      <span class="text-text-2">{{ history }}</span>
    </div>

    <div v-if="lg" class="flex flex-wrap items-center justify-between gap-12">
      <p v-if="sentence" class="max-w-640 text-text-2" data-testid="verdict-sentence">
        {{ [sentence, cost].filter(Boolean).join(' ') }}
      </p>
      <RouterLink class="btn" :to="comparison()">View comparison</RouterLink>
    </div>
    <RouterLink v-else class="btn sm self-start" :to="comparison()">View comparison</RouterLink>
  </article>
</template>
