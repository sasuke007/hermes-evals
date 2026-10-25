<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import type { ExperimentDetail } from '@/api/types/experiments';
import LiveIndicator from '@/components/ui/LiveIndicator.vue';
import ProgressBar from '@/components/ui/ProgressBar.vue';
import type { LiveState } from '@/components/ui/types';
import { formatClock, formatDuration, formatUsd } from '@/lib/format';
import { TONE_CLASSES, toneVars } from '@/lib/statusTones';
import { ROUTE_NAMES } from '@/router';
import { formatRemaining, pipelineSegments, type PipelineSegment } from './overview';

/**
 * The Progress panel of a running or paused experiment (OverviewRunning; Components 2 ›
 * ProgressBreakdown): "87 / 120 scored 72.5%", Elapsed · Remaining (est.) · Concurrency ·
 * Spend, the breakdown bar in pipeline order with a legend whose counts link to the Runs tab
 * filtered to that status, and the spend line against the ceiling.
 *
 * While the stream is down (ExperimentStates › live stream lost) or no worker is connected
 * (› no worker connected) the values freeze, not zero: the bar dims and says why. Without a
 * worker, the runs that were in flight then are named under the legend (`workerLostRuns`).
 */
const props = withDefaults(
  defineProps<{
    detail: ExperimentDetail;
    /** When the record was fetched (epoch ms): the elapsed clock counts on from there. */
    fetchedAt?: number | null;
    /** The stream's state while it is down (reconnecting or offline), else null. */
    lost?: LiveState | null;
    lostAttempt?: number | null;
    lastEventAt?: string | null;
    /** No worker heartbeat: "frozen since 15:31:04". */
    frozenSince?: string | null;
    /** While frozen: runs that were in flight, now execution_error · worker_lost. */
    workerLostRuns?: number;
  }>(),
  {
    fetchedAt: null,
    lost: null,
    lostAttempt: null,
    lastEventAt: null,
    frozenSince: null,
    workerLostRuns: 0,
  },
);
defineEmits<{ retry: [] }>();

const counts = computed(() => props.detail.counts);
const scored = computed(() => counts.value.scored);
const total = computed(() => props.detail.totalRuns);
const percent = computed(() =>
  total.value > 0 ? `${((scored.value / total.value) * 100).toFixed(1)}%` : '0.0%',
);
const ticking = computed(() => props.detail.status === 'running' && !props.lost);
const segments = computed<PipelineSegment[]>(() =>
  pipelineSegments(counts.value, ticking.value && !props.frozenSince),
);

// The elapsed clock moves on between refetches while the experiment runs.
const now = ref(Date.now());
let timer: ReturnType<typeof setInterval> | null = null;
watch(
  ticking,
  (on) => {
    if (timer !== null) clearInterval(timer);
    timer = on ? setInterval(() => (now.value = Date.now()), 1000) : null;
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  if (timer !== null) clearInterval(timer);
});
const elapsed = computed(() => {
  const base = props.detail.elapsedS;
  if (!ticking.value || props.fetchedAt === null) return base;
  return base + Math.max(0, (now.value - props.fetchedAt) / 1000);
});

const spend = computed(() => props.detail.spend);
const spendLine = computed(() => {
  const s = spend.value;
  const parts = [
    s.ceilingUsd !== null
      ? `Spend ${formatUsd(s.spentUsd)} of ${formatUsd(s.ceilingUsd)} ceiling`
      : `Spend ${formatUsd(s.spentUsd)} · no spend ceiling`,
  ];
  if (s.projectedTotalUsd !== null)
    parts.push(`projected total ≈ ${formatUsd(s.projectedTotalUsd)}`);
  if (s.unpricedAttempts > 0) {
    parts.push(
      `${s.unpricedAttempts} ${s.unpricedAttempts === 1 ? 'attempt' : 'attempts'} not priced`,
    );
  }
  return parts.join(' · ');
});

function legendStyle(segment: PipelineSegment): Record<string, string> | undefined {
  if (segment.pattern !== 'hatch' || segment.tone === 'muted') return undefined;
  const v = toneVars(segment.tone);
  return { background: `repeating-linear-gradient(135deg, ${v.solid} 0 2px, ${v.soft} 2px 4px)` };
}
function legendClass(segment: PipelineSegment): string {
  return segment.pattern === 'hatch' || segment.tone === 'muted'
    ? ''
    : TONE_CLASSES[segment.tone].solid;
}
const runsAt = (status: string) => ({
  name: ROUTE_NAMES.experimentRuns,
  params: { id: props.detail.id },
  query: { status },
});
</script>

<template>
  <section
    class="flex flex-col gap-16 rounded-6 border border-border bg-surface p-20"
    aria-label="Progress"
    data-testid="progress-panel"
  >
    <div class="flex flex-wrap items-end justify-between gap-16">
      <div class="flex flex-wrap items-baseline gap-x-10 gap-y-4">
        <span class="text-28 font-semibold" data-testid="scored-count">{{ scored }}</span>
        <span class="text-15 text-text-2">/ {{ total }} scored</span>
        <span class="text-text-3">{{ percent }}</span>
        <LiveIndicator
          v-if="lost"
          class="ml-8"
          :state="lost"
          :attempt="lostAttempt"
          :last-event-at="lastEventAt"
          @retry="$emit('retry')"
        />
        <span v-else-if="frozenSince" class="ml-8 text-12 text-text-3" data-testid="frozen-since"
          >frozen since {{ formatClock(frozenSince) }}</span
        >
      </div>
      <dl class="grid grid-cols-[repeat(4,auto)] gap-x-32 gap-y-4 max-md:grid-cols-2">
        <div class="flex min-w-0 flex-col gap-2">
          <dt class="text-12 text-text-2">Elapsed</dt>
          <dd class="font-mono text-15 font-semibold" data-testid="elapsed">
            {{ formatDuration(elapsed) }}
          </dd>
        </div>
        <div class="flex min-w-0 flex-col gap-2">
          <dt class="text-12 text-text-2">Remaining (est.)</dt>
          <dd class="font-mono text-15 font-semibold">
            {{ formatRemaining(detail.remainingEstimateS) }}
          </dd>
        </div>
        <div class="flex min-w-0 flex-col gap-2">
          <dt class="text-12 text-text-2">Concurrency</dt>
          <dd class="font-mono text-15 font-semibold">{{ detail.concurrency }}</dd>
        </div>
        <div class="flex min-w-0 flex-col gap-2">
          <dt class="text-12 text-text-2">Spend</dt>
          <dd class="font-mono text-15 font-semibold" data-testid="spend">
            {{ formatUsd(spend.spentUsd) }}
            <span v-if="spend.ceilingUsd !== null" class="text-12 font-normal text-text-3"
              >of {{ formatUsd(spend.ceilingUsd) }}</span
            >
          </dd>
        </div>
      </dl>
    </div>

    <ProgressBar
      :class="{ 'opacity-60': lost || frozenSince }"
      :max="total"
      :now="scored"
      :segments="segments"
      :height="12"
      :label="`${scored} of ${total} runs scored`"
    />

    <div class="flex flex-wrap gap-x-28 gap-y-8" data-testid="progress-legend">
      <RouterLink
        v-for="segment in segments"
        :key="segment.status"
        :to="runsAt(segment.status)"
        class="inline-flex items-center gap-8 text-text hover:text-text"
        :title="`Show ${segment.status} runs`"
        :data-status="segment.status"
      >
        <span
          class="inline-block size-10 flex-none rounded-2"
          :class="legendClass(segment)"
          :style="legendStyle(segment)"
          aria-hidden="true"
        />
        <span class="font-mono text-12">{{ segment.status }}</span>
        <span class="font-semibold">{{ segment.value }}</span>
      </RouterLink>
    </div>

    <p
      v-if="frozenSince && workerLostRuns > 0"
      class="text-12 text-text-3"
      data-testid="worker-lost"
    >
      {{
        workerLostRuns === 1
          ? '1 run that was in flight is marked'
          : `${workerLostRuns} runs that were in flight are marked`
      }}
      <code>execution_error · worker_lost</code> and can be retried.
    </p>

    <p v-if="lost" class="text-text-2">
      The experiment keeps running in the worker; only this page has lost its connection. Counts
      resume from the server's totals on reconnect, never from the last frozen value.
    </p>

    <div v-if="spend.ceilingUsd !== null" class="flex items-center gap-10">
      <div class="min-w-120 flex-1">
        <ProgressBar
          :max="spend.ceilingUsd"
          :value="Math.min(spend.spentUsd, spend.ceilingUsd)"
          tone="muted"
          :height="4"
          :label="spendLine"
        />
      </div>
      <span class="text-12 text-text-3" data-testid="spend-line">{{ spendLine }}</span>
    </div>
    <p v-else class="text-12 text-text-3" data-testid="spend-line">{{ spendLine }}</p>
  </section>
</template>
