<script setup lang="ts">
import { computed } from 'vue';
import type { ExperimentEstimateView, PriceEntry } from '@/api/types/experiments';
import BlockedReason from '@/components/model-access/BlockedReason.vue';
import { formatCount, formatUsd } from '@/lib/format';
import { ROUTE_NAMES } from '@/router';
import LaunchBlockerCard from './LaunchBlockerCard.vue';
import type { LaunchBlocker, LaunchFailure } from './launchReadiness';

/**
 * The sticky panel beside New experiment (Components 2 › ExperimentSummaryPanel). It shows the
 * multiplication itself, not only the result, so the user sees which factor to reduce, then
 * the estimate from GET /experiments/estimate with its basis stated. The blocks are
 * LaunchBlockerCard's: a provider, unset MCP variables (Check again re-emits `recheck`), the
 * worker or the sandbox.
 *
 * States: incomplete (Runs —, Launch disabled with the first unmet requirement) · valid ·
 * over ceiling (an amber line; Launch stays enabled and the spend guard pauses at the
 * ceiling) · unknown price (cost —, Launch stays enabled) · blocked (a provider, the worker or
 * the sandbox: a block above the estimate, Launch disabled through BlockedReason) · launching
 * (spinner, the form locked) · launch failed (the alert, the form keeps its values) · warned
 * (an amber line above Launch, which stays enabled: the mock model would judge a real one).
 */
const props = withDefaults(
  defineProps<{
    /** The three factors; null shows —. */
    taskCount: number | null;
    configCount: number | null;
    repetitions: number | null;
    concurrency: number | null;
    estimate: ExperimentEstimateView | null;
    estimateLoading?: boolean;
    estimateError?: string | null;
    suiteName: string | null;
    /** Tokens per run the estimate assumes (15,000 without history). */
    perRunTokens?: number | null;
    /**
     * The chosen configurations with no past runs on the suite. When only some lack them, the
     * note names those, since the others' estimates are measured.
     */
    withoutHistory?: string[];
    priceTable: PriceEntry[];
    /** Models of the chosen configurations. */
    models: string[];
    spendCeilingUsd?: number | null;
    /** The form's first unmet requirement; Launch is disabled with it. */
    invalidReason: string | null;
    blockers?: LaunchBlocker[];
    /** A warning that does not block the launch: the mock judge's (Phase 8 G2). */
    warning?: string | null;
    busy?: boolean;
    failure?: LaunchFailure | null;
  }>(),
  {
    estimateLoading: false,
    estimateError: null,
    perRunTokens: null,
    withoutHistory: () => [],
    spendCeilingUsd: null,
    blockers: () => [],
    warning: null,
    busy: false,
    failure: null,
  },
);
const emit = defineEmits<{ launch: []; connect: []; recheck: [] }>();

const dash = (n: number | null): string => (n === null ? '—' : String(n));

/** tasks × configurations × repetitions, once there are two configurations to compare. */
const runs = computed<number | null>(() => {
  const { taskCount, configCount, repetitions } = props;
  if (!taskCount || !configCount || configCount < 2 || !repetitions) return null;
  return taskCount * configCount * repetitions;
});

const history = computed(() => props.estimate?.basis === 'history');
const prices = computed(() => {
  const distinct = [...new Set(props.models)];
  return distinct.map((model) => ({
    model,
    price: props.priceTable.find((p) => p.model === model) ?? null,
  }));
});
const unpriced = computed(() => prices.value.filter((p) => p.price === null).map((p) => p.model));
const rate = (p: PriceEntry): string =>
  `${formatUsd(p.inputPer1M)} in / ${formatUsd(p.outputPer1M)} out`;

/** ≈ 36 min · ≈ 1h 05m · ≈ 45 s. */
const duration = computed(() => {
  const s = props.estimate?.durationS;
  if (s === undefined) return '—';
  if (s < 60) return `≈ ${Math.max(1, Math.round(s))} s`;
  const mins = Math.round(s / 60);
  return mins >= 60
    ? `≈ ${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`
    : `≈ ${mins} min`;
});
const durationBasis = computed(() => {
  const e = props.estimate;
  if (!e) return '';
  const per = `${Math.round(e.perRunSeconds)} s${history.value ? ' median' : ''} per run`;
  return `${formatCount(e.waves)} waves at concurrency ${props.concurrency ?? '—'} × ${per}`;
});
const cost = computed(() =>
  props.estimate && props.estimate.costUsd !== null
    ? `≈ ${formatUsd(props.estimate.costUsd)}`
    : '—',
);
const costBasis = computed(() => {
  const e = props.estimate;
  if (!e || e.costUsd === null) return '';
  if (history.value) return `${formatCount(e.runs)} runs at the per-configuration median cost`;
  const tokens = formatCount(props.perRunTokens ?? 15_000);
  const only = prices.value.length === 1 ? prices.value[0]!.price : null;
  return only
    ? `${formatCount(e.runs)} runs × ${tokens} tokens at ${rate(only)} per 1M`
    : `${formatCount(e.runs)} runs × ${tokens} tokens at the price table's rates`;
});
const overCeiling = computed(() => {
  const cost = props.estimate?.costUsd ?? null;
  return props.spendCeilingUsd !== null && cost !== null && cost > props.spendCeilingUsd;
});
const basisNote = computed(() => {
  const e = props.estimate;
  const suite = props.suiteName ?? 'this suite';
  if (!e) return null;
  if (!history.value) {
    const tokens = formatCount(props.perRunTokens ?? 15_000);
    const fresh = props.withoutHistory;
    if (fresh.length > 0 && fresh.length < (props.configCount ?? 0)) {
      const names =
        fresh.length === 1
          ? fresh[0]
          : `${fresh.slice(0, -1).join(', ')} and ${fresh[fresh.length - 1]}`;
      const one = fresh.length === 1;
      return `${names} ${one ? 'has' : 'have'} no past runs on ${suite} yet, so ${one ? 'its per-run estimate assumes' : 'their per-run estimates assume'} the time budget ÷ 4 and ${tokens} tokens; the other configurations use their measured medians.`;
    }
    return `No past runs on ${suite} yet, so the per-run estimate assumes the time budget ÷ 4 and ${tokens} tokens. After the first experiment it uses the measured medians.`;
  }
  const priced = prices.value.filter((p) => p.price !== null);
  const table =
    priced.length === 0
      ? ''
      : `, and the price table for ${priced.map((p) => `${p.model}: ${rate(p.price!)}`).join('; ')} per 1M tokens`;
  return `Estimates use the medians of ${formatCount(e.pastRuns)} past runs on ${suite} per configuration${table}.`;
});

const blocked = computed(() => props.blockers.length > 0);
/** The form's own reason comes first; a blocker's shows once the form is complete. */
const showBlocked = computed(() => blocked.value && props.invalidReason === null && !props.busy);
const disabled = computed(() => props.invalidReason !== null || blocked.value || props.busy);
const label = computed(() =>
  props.invalidReason === null && runs.value !== null
    ? `Launch ${formatCount(runs.value)} runs`
    : 'Launch',
);
const firstBlocker = computed(() => props.blockers[0] ?? null);
const fix = computed(() => {
  const b = firstBlocker.value;
  if (!b) return { label: null, to: null };
  switch (b.fix) {
    case 'connect':
      return { label: 'Connect', to: null };
    case 'reconnect':
      return { label: 'Reconnect', to: null };
    case 'add-key':
      return { label: 'How to add it', to: { name: ROUTE_NAMES.system } };
    case 'secrets':
      return {
        label: 'Open Secrets',
        to: { name: ROUTE_NAMES.resourcesTab, params: { tab: 'secrets' } },
      };
    default:
      return { label: 'Open System', to: { name: ROUTE_NAMES.system } };
  }
});
</script>

<template>
  <aside
    class="flex flex-col gap-16 rounded-6 border border-border bg-surface p-18 shadow-float"
    aria-label="Experiment summary"
    data-testid="summary-panel"
  >
    <div class="flex items-center justify-between">
      <span class="text-15 font-semibold">Summary</span>
      <span class="text-12 text-text-3">updates as you edit</span>
    </div>

    <dl class="flex flex-col gap-6" data-testid="summary-factors">
      <div class="flex justify-between">
        <dt class="text-text-2">Tasks</dt>
        <dd>{{ dash(taskCount) }}</dd>
      </div>
      <div class="flex justify-between">
        <dt class="text-text-2">× Configurations</dt>
        <dd>{{ dash(configCount) }}</dd>
      </div>
      <div class="flex justify-between">
        <dt class="text-text-2">× Repetitions</dt>
        <dd>{{ dash(repetitions) }}</dd>
      </div>
      <div class="flex items-baseline justify-between border-t border-border pt-8">
        <dt class="font-semibold">= Runs</dt>
        <dd
          class="text-28 font-semibold"
          :class="{ 'text-text-3': runs === null }"
          data-testid="summary-runs"
        >
          {{ runs === null ? '—' : formatCount(runs) }}
        </dd>
      </div>
    </dl>

    <LaunchBlockerCard
      v-for="(blocker, i) in blockers"
      :key="i"
      :blocker="blocker"
      @connect="emit('connect')"
      @recheck="emit('recheck')"
    />

    <template v-if="runs !== null">
      <div class="flex flex-col gap-4" :aria-busy="estimateLoading || undefined">
        <div class="flex justify-between">
          <span class="text-text-2">Estimated duration</span>
          <span class="font-semibold" data-testid="summary-duration">{{ duration }}</span>
        </div>
        <div v-if="durationBasis" class="text-12 text-text-3">{{ durationBasis }}</div>
      </div>
      <div class="flex flex-col gap-4">
        <div class="flex justify-between">
          <span class="text-text-2">Estimated cost</span>
          <span
            class="font-semibold"
            :class="{ 'text-ung-text': overCeiling, 'text-text-3': cost === '—' }"
            data-testid="summary-cost"
            >{{ cost }}</span
          >
        </div>
        <div v-if="costBasis" class="text-12 text-text-3">{{ costBasis }}</div>
        <template v-if="estimate && estimate.costUsd !== null">
          <div
            v-for="row in estimate.perConfiguration"
            :key="row.versionId"
            class="flex justify-between text-12 text-text-3"
            data-testid="summary-cost-row"
          >
            <span class="font-mono">{{ row.name }}</span>
            <span>{{ row.costUsd === null ? '—' : `≈ ${formatUsd(row.costUsd)}` }}</span>
          </div>
        </template>
        <div
          v-if="estimate && unpriced.length > 0"
          class="text-12 text-ung-text"
          data-testid="unknown-price"
        >
          No price for
          <template v-for="(model, i) in unpriced" :key="model"
            ><code>{{ model }}</code
            >{{ i < unpriced.length - 1 ? ', ' : '' }}</template
          >
          in the price table. Add it in <code>config/prices.yaml</code> to see estimates.
        </div>
        <template v-if="overCeiling">
          <div class="flex justify-between">
            <span class="text-text-2">Spend ceiling</span>
            <span class="font-mono">{{ formatUsd(spendCeilingUsd) }}</span>
          </div>
          <div
            role="status"
            class="flex items-start gap-8 rounded-4 border border-ung bg-ung-soft px-10 py-8"
            data-testid="over-ceiling"
          >
            <span class="mt-7 size-6 flex-none rounded-full bg-ung" aria-hidden="true" />
            <span class="text-12 leading-18"
              ><b class="text-ung-text"
                >Estimated {{ formatUsd(estimate!.costUsd) }} is over the ceiling of
                {{ formatUsd(spendCeilingUsd) }}.</b
              >{{ ' '
              }}<span class="text-text-2"
                >The experiment will pause when spend reaches {{ formatUsd(spendCeilingUsd) }}.
                Raise the ceiling in section 5 to avoid the pause.</span
              ></span
            >
          </div>
        </template>
      </div>
      <div v-if="estimateError" class="text-12 text-fail-text" data-testid="estimate-error">
        Could not estimate: {{ estimateError }}
      </div>
      <div v-else-if="basisNote" class="rounded-4 bg-surface-2 px-10 py-8 text-12 text-text-3">
        {{ basisNote }}
      </div>
    </template>

    <div
      v-if="warning"
      role="status"
      class="flex items-start gap-8 rounded-4 border border-ung bg-ung-soft px-10 py-8"
      data-testid="judge-warning"
    >
      <span class="mt-7 size-6 flex-none rounded-full bg-ung" aria-hidden="true" />
      <span class="text-12 leading-18 text-ung-text">{{ warning }}</span>
    </div>

    <div
      v-if="failure"
      role="alert"
      class="flex flex-col gap-6 rounded-6 border border-fail bg-fail-soft px-12 py-10"
      :data-kind="failure.kind"
      data-testid="launch-failure"
    >
      <b class="text-fail-text">{{ failure.title }}</b>
      <code class="text-12 wrap-anywhere text-text-2">{{ failure.message }}</code>
      <span class="text-12 text-text-3">{{ failure.hint }}</span>
      <button
        v-if="failure.action"
        type="button"
        class="btn primary h-28 self-start text-12"
        @click="emit('connect')"
      >
        {{ failure.action === 'connect' ? 'Connect Nous Portal' : 'Reconnect Nous Portal' }}
      </button>
    </div>

    <div class="flex flex-col gap-6">
      <BlockedReason
        v-slot="{ attrs }"
        :blocked="showBlocked"
        :reason="firstBlocker?.reason ?? ''"
        :fix-label="fix.label"
        :fix-to="fix.to"
        @fix="emit('connect')"
      >
        <button
          type="button"
          class="btn primary w-full"
          :disabled="disabled"
          :aria-busy="busy || undefined"
          :aria-describedby="invalidReason && !busy ? 'ne-launch-reason' : undefined"
          v-bind="attrs"
          data-testid="launch"
          @click="emit('launch')"
        >
          <template v-if="busy">
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" class="animate-spin">
              <circle
                cx="7"
                cy="7"
                r="5"
                fill="none"
                stroke="currentColor"
                stroke-width="1.6"
                stroke-dasharray="20 12"
                stroke-linecap="round"
              />
            </svg>
            Launching…
          </template>
          <template v-else>{{ label }}</template>
        </button>
      </BlockedReason>
      <span v-if="busy" class="text-12 text-text-3"
        >Freezing the snapshot and queueing {{ formatCount(runs) }} runs. The form is locked until
        the server answers.</span
      >
      <span
        v-else-if="invalidReason"
        id="ne-launch-reason"
        class="text-12 text-fail-text"
        data-testid="launch-reason"
        >{{ invalidReason }}</span
      >
      <span v-else-if="!blocked" class="text-12 text-text-3" data-testid="launch-reason"
        >Starts immediately. You can pause or cancel from the Overview.</span
      >
    </div>
  </aside>
</template>
