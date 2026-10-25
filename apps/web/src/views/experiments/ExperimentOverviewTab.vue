<script setup lang="ts">
/**
 * The Overview tab (OverviewRunning, OverviewComplete, ExperimentStates; UI_FLOWS 14.2):
 *   running, paused  Progress (breakdown, stats, spend line), Per configuration, Latest
 *                    completions, the provisional VerdictCards and the frozen snapshot strip;
 *                    above them the pause or no-worker state when there is one.
 *   failed           the circuit breaker's banner, what ran, the snapshot strip.
 *   completed        one VerdictCard per candidate with What was tested, then the
 *                    per-configuration aggregates.
 * The record and its live updates belong to the page (stores/experiment-detail.ts); this tab
 * draws them. A first load that fails replaces the body with the ErrorBanner; a refresh that
 * fails keeps the last good data under it.
 */
import { computed, ref, watch } from 'vue';
import AggregatesTable from '@/components/overview/AggregatesTable.vue';
import ConfigProgressPanel from '@/components/overview/ConfigProgressPanel.vue';
import FailedPanel from '@/components/overview/FailedPanel.vue';
import LatestCompletions from '@/components/overview/LatestCompletions.vue';
import NoWorkerBanner from '@/components/overview/NoWorkerBanner.vue';
import ProgressPanel from '@/components/overview/ProgressPanel.vue';
import ProviderPauseLine from '@/components/overview/ProviderPauseLine.vue';
import SnapshotStrip from '@/components/overview/SnapshotStrip.vue';
import SpendCeilingPause from '@/components/overview/SpendCeilingPause.vue';
import VerdictCard from '@/components/overview/VerdictCard.vue';
import WhatWasTested from '@/components/overview/WhatWasTested.vue';
import { provisionalLine } from '@/components/overview/overview';
import { firstBlocked, providerState } from '@/components/runs/modelAccess';
import ErrorBanner from '@/components/ui/ErrorBanner.vue';
import { formatClock } from '@/lib/format';
import { useExperimentDetailStore } from '@/stores/experiment-detail';
import { useProvidersStore } from '@/stores/providers';
import { useRouter } from 'vue-router';

const props = defineProps<{ experimentId: string }>();

const store = useExperimentDetailStore();
const providers = useProvidersStore();
const router = useRouter();

const detail = computed(() => store.records[props.experimentId] ?? null);
const status = computed(() => detail.value?.status ?? null);
const live = computed(() => status.value === 'running' || status.value === 'paused');
const multi = computed(() => (detail.value?.candidates.length ?? 0) > 1);
const noWorker = computed(
  () => !!detail.value && !detail.value.worker.connected && detail.value.status === 'running',
);
const lost = computed(() => (store.frozen ? store.liveIndicator : null));

// The inspector's J/K follows the feed when a run is opened from it.
watch(
  () => detail.value?.feed.map((f) => f.runId).join(','),
  () => {
    if (detail.value) store.setRunOrder(detail.value.feed.map((f) => f.runId));
  },
  { immediate: true },
);
function openRun(runId: string): void {
  void router.push({ query: { ...router.currentRoute.value.query, run: runId } });
}

// ── a provider pause ─────────────────────────────────────────────────────
const providerIds = computed(() =>
  detail.value
    ? [detail.value.baseline.provider, ...detail.value.candidates.map((c) => c.provider)]
    : [],
);
/** The provider in the way, or (once it is back) the one most likely to have paused it. */
const pausedProvider = computed(() => {
  const blocked = firstBlocked(providers, providerIds.value);
  if (blocked) return blocked;
  const nous = providerIds.value.find((id) => id === 'nous');
  const id = nous ?? providerIds.value[0];
  return id ? providerState(providers, id) : null;
});
const reconnectedAt = ref<string | null>(null);
watch(
  () => pausedProvider.value?.ready,
  (ready, before) => {
    if (ready && before === false) reconnectedAt.value = new Date().toISOString();
  },
);

const resumeBusy = computed(() => store.acting === 'resume');
function resumeWith(spendCeilingUsd: number): void {
  void store.resume({ spendCeilingUsd });
}

const refreshError = computed(() => (detail.value ? store.error : null));
const loadedAt = computed(() => {
  const at = store.fetchedAt[props.experimentId];
  return at ? formatClock(at) : null;
});
</script>

<template>
  <!-- First load ------------------------------------------------------------------------>
  <div
    v-if="!detail && !store.error"
    class="flex flex-col gap-10 rounded-6 border border-border bg-surface px-16 py-14"
    aria-busy="true"
    aria-label="Loading this experiment"
    data-testid="overview-loading"
  >
    <div class="flex items-center gap-8" aria-hidden="true">
      <span class="block h-10 w-320 animate-shimmer rounded-3 bg-surface-3" />
      <span class="block h-20 w-70 animate-shimmer rounded-3 bg-surface-3" />
    </div>
    <span class="block h-12 w-full animate-shimmer rounded-3 bg-surface-3" aria-hidden="true" />
    <div class="flex items-center gap-8" aria-hidden="true">
      <span
        v-for="w in [180, 120, 140, 90]"
        :key="w"
        class="block h-10 animate-shimmer rounded-3 bg-surface-3"
        :style="{ width: `${w}px` }"
      />
    </div>
    <span class="block h-56 w-full animate-shimmer rounded-3 bg-surface-3" aria-hidden="true" />
    <div class="flex items-center gap-8" aria-hidden="true">
      <span
        v-for="w in [240, 200, 160]"
        :key="w"
        class="block h-10 animate-shimmer rounded-3 bg-surface-3"
        :style="{ width: `${w}px` }"
      />
    </div>
  </div>
  <ErrorBanner
    v-else-if="!detail"
    title="Could not load this experiment"
    :detail="store.error"
    hint="The tab bar stays usable. Check that the api service is running: docker compose ps api."
    retry-label="Retry"
    data-testid="overview-error"
    @retry="store.refresh()"
  />

  <!-- The experiment -------------------------------------------------------------------->
  <div v-else class="flex flex-col gap-16" :data-status="detail.status">
    <ErrorBanner
      v-if="refreshError"
      title="Could not refresh this experiment"
      :detail="refreshError"
      :hint="loadedAt ? `Showing data from ${loadedAt}.` : null"
      retry-label="Retry"
      data-testid="overview-refresh-error"
      @retry="store.refresh()"
    />

    <template v-if="live">
      <NoWorkerBanner v-if="noWorker" :worker="detail.worker" :queued="detail.counts.queued" />
      <SpendCeilingPause
        v-if="detail.status === 'paused' && detail.pauseReason === 'spend_ceiling'"
        :detail="detail"
        :busy="resumeBusy"
        @resume="resumeWith"
      />
      <ProviderPauseLine
        v-if="
          detail.status === 'paused' &&
          detail.pauseReason === 'provider_disconnected' &&
          pausedProvider
        "
        :paused-at="detail.pausedAt"
        :provider="pausedProvider"
        :reconnected-at="reconnectedAt"
      />
      <ProgressPanel
        :detail="detail"
        :fetched-at="store.fetchedAt[experimentId] ?? null"
        :lost="lost"
        :lost-attempt="store.liveAttempt"
        :last-event-at="store.lastEventAt"
        :frozen-since="noWorker ? detail.worker.lastHeartbeatAt : null"
        :worker-lost-runs="detail.worker.workerLostRuns"
        @retry="store.retryLive()"
      />
      <div class="grid grid-cols-[repeat(auto-fit,minmax(min(520px,100%),1fr))] items-start gap-16">
        <ConfigProgressPanel :per-configuration="detail.perConfiguration" />
        <LatestCompletions :feed="detail.feed" :arrived="store.arrivedRunIds" @open="openRun" />
      </div>
      <section
        v-if="detail.verdicts.length"
        class="grid grid-cols-[repeat(auto-fill,minmax(min(520px,100%),1fr))] items-start gap-16"
        aria-label="Verdict so far"
      >
        <VerdictCard
          v-for="v in detail.verdicts"
          :key="v.candidate.versionId"
          :verdict="v"
          :experiment-id="detail.id"
          :suite-name="detail.suite.name"
          :provisional-line="provisionalLine(detail)"
          :multi-candidate="multi"
        />
      </section>
      <SnapshotStrip :detail="detail" />
    </template>

    <template v-else-if="detail.status === 'failed' && detail.failure">
      <FailedPanel :detail="detail" :failure="detail.failure" />
      <SnapshotStrip :detail="detail" />
    </template>

    <template v-else>
      <div
        class="grid items-stretch gap-16"
        :class="
          multi
            ? 'grid-cols-[repeat(auto-fit,minmax(min(420px,100%),1fr))]'
            : 'grid-cols-[repeat(auto-fit,minmax(min(560px,100%),1fr))]'
        "
      >
        <VerdictCard
          v-for="v in detail.verdicts"
          :key="v.candidate.versionId"
          :verdict="v"
          :experiment-id="detail.id"
          :suite-name="detail.suite.name"
          :size="multi ? 'md' : 'lg'"
          :aggregates="detail.aggregates"
          :multi-candidate="multi"
        />
        <WhatWasTested :detail="detail" />
      </div>
      <AggregatesTable :aggregates="detail.aggregates" :experiment-id="detail.id" />
    </template>
  </div>
</template>
