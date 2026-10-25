<script setup lang="ts">
/**
 * Experiment detail: the header, the tab row (Overview · Comparison · Runs) and the run
 * inspector drawer (OverviewRunning, OverviewComplete, Comparison, Runs).
 *
 * The page owns the experiment's record and its live stream (stores/experiment-detail.ts):
 * open(id) loads GET /experiments/:id and streams /experiments/:id/events, whose `run` events
 * also patch the Runs tab and reach the comparison and the inspector through onRunEvent.
 * On the Overview the header carries the caption, the controls and the cancel confirmation,
 * and the tab row ends in the live status; on Comparison and Runs it is the breadcrumb, the
 * title and the status chip, as their boards draw it.
 *
 * The drawer shows whenever the route names a run: `experiment-run`
 * (/experiments/:id/runs/:runId, opened from the Runs tab) or `?run=<runId>` on any tab
 * (opened from the comparison grid or the Overview feed), so the tab behind keeps its state.
 * Its J/K order is the list the tab that opened it set (setRunOrder).
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { RouterView, useRoute, useRouter, type LocationQuery } from 'vue-router';
import RunInspectorDrawer from '@/components/inspector/RunInspectorDrawer.vue';
import PageContainer from '@/components/layout/PageContainer.vue';
import ExperimentControls from '@/components/overview/ExperimentControls.vue';
import ExperimentLiveStatus from '@/components/overview/ExperimentLiveStatus.vue';
import { cancelSummary, metaTail } from '@/components/overview/overview';
import BaseBreadcrumb from '@/components/ui/BaseBreadcrumb.vue';
import ConfirmInline from '@/components/ui/ConfirmInline.vue';
import ErrorBanner from '@/components/ui/ErrorBanner.vue';
import PageHeader from '@/components/ui/PageHeader.vue';
import StatusChip from '@/components/ui/StatusChip.vue';
import TabNav from '@/components/ui/TabNav.vue';
import type { BreadcrumbItem, TabItem } from '@/components/ui/types';
import { inspectedRunId, ROUTE_NAMES } from '@/router';
import { useExperimentDetailStore } from '@/stores/experiment-detail';
import { useRunsStore } from '@/stores/runs';

const props = defineProps<{ experimentId: string }>();

const route = useRoute();
const router = useRouter();
const store = useExperimentDetailStore();
const runs = useRunsStore();

const detail = computed(() => store.records[props.experimentId] ?? null);
const runId = computed(() => inspectedRunId(route));
const onOverview = computed(() => route.name === ROUTE_NAMES.experimentOverview);
const onRuns = computed(
  () => route.name === ROUTE_NAMES.experimentRuns || route.name === ROUTE_NAMES.experimentRun,
);

const breadcrumbs = computed<BreadcrumbItem[]>(() => [
  { label: 'Experiments', to: { name: ROUTE_NAMES.experiments } },
  { label: detail.value?.name ?? props.experimentId },
]);
const provisional = computed(() => !!detail.value && detail.value.status !== 'completed');

const tabs = computed<TabItem[]>(() => [
  {
    label: 'Overview',
    to: { name: ROUTE_NAMES.experimentOverview, params: { id: props.experimentId } },
    exact: true,
  },
  {
    label: 'Comparison',
    to: { name: ROUTE_NAMES.experimentComparison, params: { id: props.experimentId } },
  },
  {
    label: 'Runs',
    to: { name: ROUTE_NAMES.experimentRuns, params: { id: props.experimentId } },
    count: detail.value?.totalRuns ?? null,
    // The drawer opened from Runs is the sibling route runs/:runId: Runs stays current.
    active: onRuns.value,
  },
]);

// ── cancel ───────────────────────────────────────────────────────────────
const confirming = ref(false);
const controls = ref<InstanceType<typeof ExperimentControls> | null>(null);
const cancelText = computed(() => (detail.value ? cancelSummary(detail.value.counts) : null));
/** The consequence in pieces, so `cancelled` (the status) is set in mono as the board does. */
const cancelParts = computed(() => cancelText.value?.consequence.split(/\b(cancelled)\b/) ?? []);
const cancelError = computed(() =>
  store.actionError?.action === 'cancel' ? store.actionError.message : null,
);
/** An error of the other controls (a 409 on Pause or Resume), shown under the header. */
const controlError = computed(() =>
  store.actionError && store.actionError.action !== 'cancel' ? store.actionError : null,
);
const CONTROL_TITLES = {
  pause: 'Could not pause',
  resume: 'Could not resume',
  'retry-failed': 'Could not retry the failed runs',
  cancel: 'Could not cancel',
} as const;

async function confirmCancel(): Promise<void> {
  const ok = await store.cancel();
  if (!ok) return;
  confirming.value = false;
  // The confirmation is gone, and Cancel with it: focus goes to the page title.
  await nextTick();
  if (!document.activeElement || document.activeElement === document.body) pageTitle()?.focus();
}

/** The page's h1, focusable from script (tabindex -1), where focus lands when its control left. */
function pageTitle(): HTMLElement | null {
  const h1 = document.querySelector<HTMLElement>('[data-testid="experiment-header"] h1');
  h1?.setAttribute('tabindex', '-1');
  return h1;
}
function backOut(): void {
  store.clearActionError();
  confirming.value = false;
  setTimeout(() => controls.value?.focusCancel(), 0);
}

const inFlight = computed(() => {
  const c = detail.value?.counts;
  return c ? c.running + c.executed + c.scoring : 0;
});

// ── the record and its stream ────────────────────────────────────────────
watch(
  () => props.experimentId,
  (id) => {
    confirming.value = false;
    void store.open(id);
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  store.close();
  runs.reset();
});

// ── the drawer ───────────────────────────────────────────────────────────
function withoutRun(query: LocationQuery): LocationQuery {
  const rest = { ...query };
  delete rest.run;
  return rest;
}

/** Opens a run in the drawer the same way it was opened (route param or ?run=). */
function openRun(id: string): void {
  if (route.name === ROUTE_NAMES.experimentRun || route.name === ROUTE_NAMES.experimentRuns) {
    void router.push({
      name: ROUTE_NAMES.experimentRun,
      params: { id: props.experimentId, runId: id },
      query: withoutRun(route.query),
    });
  } else {
    void router.push({ query: { ...route.query, run: id } });
  }
}

/** The last run the drawer showed: focus goes back to it when the drawer closes. */
let lastRunId: string | null = null;
watch(
  runId,
  (id) => {
    if (id) lastRunId = id;
  },
  { immediate: true },
);

/**
 * Where focus goes when the drawer closes and its opener is gone (a feed row that moved on,
 * a drawer opened by URL): the run's link or grid cell on the tab, else the current tab, else
 * the page title.
 */
function inspectorReturn(): HTMLElement | null {
  const outside = (selector: string) =>
    [...document.querySelectorAll<HTMLElement>(selector)].find(
      (el) => !el.closest('[data-testid="run-inspector"]'),
    ) ?? null;
  const id = lastRunId;
  const run =
    id && /^[\w-]+$/.test(id)
      ? outside(`[data-run-id="${id}"] a[href], button[data-run-id="${id}"]`)
      : null;
  return run ?? outside('nav[aria-label="Experiment"] a[aria-current="page"]') ?? pageTitle();
}

function closeInspector(): void {
  if (route.name === ROUTE_NAMES.experimentRun) {
    void router.push({
      name: ROUTE_NAMES.experimentRuns,
      params: { id: props.experimentId },
      query: route.query,
    });
  } else {
    void router.push({ query: withoutRun(route.query) });
  }
}
</script>

<template>
  <PageContainer variant="detail" :gap="onRuns ? 14 : 16">
    <PageHeader
      v-if="detail"
      :title="detail.name"
      :breadcrumbs="breadcrumbs"
      data-testid="experiment-header"
    >
      <template #title-extra>
        <StatusChip kind="experiment" :status="detail.status" data-testid="experiment-status" />
        <StatusChip
          v-if="detail.status === 'paused' && detail.pauseReason === 'provider_disconnected'"
          kind="pauseReason"
          :status="detail.pauseReason"
          title="Pause reason"
        />
      </template>
      <template v-if="onOverview" #meta>
        <div class="text-12 text-text-3" data-testid="experiment-meta">
          <span class="font-mono">{{ detail.baseline.name }}</span> vs
          <template v-for="(c, i) in detail.candidates" :key="c.versionId"
            >{{ i ? ', ' : '' }}<span class="font-mono">{{ c.name }}</span></template
          >
          · {{ metaTail(detail) }}
        </div>
      </template>
      <template v-if="onOverview" #actions>
        <ExperimentControls
          ref="controls"
          :detail="detail"
          :confirming="confirming"
          @cancel="confirming = true"
        />
      </template>
    </PageHeader>
    <div v-else class="flex flex-col gap-4" data-testid="experiment-header-loading">
      <BaseBreadcrumb :items="breadcrumbs" />
      <div
        v-if="store.loading"
        class="flex h-28 items-center gap-10"
        aria-busy="true"
        aria-label="Loading this experiment"
      >
        <span class="block h-20 w-320 animate-shimmer rounded-3 bg-surface-3" />
        <span class="block h-20 w-70 animate-shimmer rounded-3 bg-surface-3" />
      </div>
      <h1 v-else class="font-mono text-20 font-semibold">{{ experimentId }}</h1>
    </div>

    <ConfirmInline
      v-if="onOverview && detail && cancelText"
      v-show="confirming"
      v-model:open="confirming"
      layout="columns"
      :title="cancelText.title"
      :consequence="cancelText.consequence"
      confirm-label="Cancel experiment"
      :cancel-label="detail.status === 'paused' ? 'Keep paused' : 'Keep running'"
      label="Confirm cancel"
      busy-label="Cancelling…"
      error-title="Could not cancel. Nothing was stopped."
      :busy="store.acting === 'cancel'"
      :error="cancelError"
      @confirm="confirmCancel"
      @cancel="backOut"
    >
      <template #consequence>
        <template v-for="(part, i) in cancelParts" :key="i"
          ><span v-if="i % 2 === 1" class="font-mono">{{ part }}</span
          ><template v-else>{{ part }}</template></template
        >
      </template>
    </ConfirmInline>
    <ErrorBanner
      v-if="onOverview && controlError"
      :title="CONTROL_TITLES[controlError.action]"
      :detail="controlError.message"
      retry-label="Dismiss"
      data-testid="control-error"
      @retry="store.clearActionError()"
    />

    <TabNav :tabs="tabs" label="Experiment">
      <template #extra="{ tab }">
        <span
          v-if="tab.label === 'Comparison' && provisional"
          class="chip h-18 bg-surface-2 font-medium text-text-3"
          >provisional</span
        >
      </template>
      <div class="flex-1" />
      <ExperimentLiveStatus
        v-if="detail && (onOverview || onRuns)"
        :status="detail.status"
        :stream="store.liveIndicator"
        :attempt="store.liveAttempt"
        :last-event-at="store.lastEventAt"
        :in-flight="inFlight"
        @retry="store.retryLive()"
      />
    </TabNav>
    <RouterView />
    <RunInspectorDrawer
      v-if="runId"
      :run-id="runId"
      :experiment-id="experimentId"
      :siblings="store.runOrder"
      :return-focus-to="inspectorReturn"
      @close="closeInspector"
      @navigate="openRun"
    />
  </PageContainer>
</template>
