<script setup lang="ts">
/**
 * The Comparison tab (plan 12.2 item 6, UI_FLOWS 16; boards Comparison, ComparisonStates,
 * ComparisonDark, ExperimentStates): is the candidate better than the baseline, and how sure
 * are we? One candidate against the baseline, task by task, every number linked to the runs
 * beneath it: a cell opens its run in the inspector (?run=), J/K then follow the grid.
 *
 * The URL holds the view: ?candidate=<version id>&key=<score key>&show=<filter>&sort=task
 * (defaults: the first candidate, each task's primary key, all tasks, by Δ). States: loading,
 * load error (the controls keep their values; Retry reloads with them), provisional while the
 * experiment runs, is paused or failed (dashed statistics, unscored cells), not computable
 * with the API's reason (nothing scored yet, one repetition, too few runs, too few tasks), and
 * a filter with no rows. Live: the experiment page's stream patches cells as runs move and a
 * refetch follows (src/stores/comparison.ts).
 */
import { COMPARISON_FILTERS, SCORE_KEY_PRIMARY } from '@hermes-evals/shared';
import { computed, onBeforeUnmount, watch } from 'vue';
import { RouterLink, useRoute, useRouter, type RouteLocationRaw } from 'vue-router';
import { errorMessage, isApiError } from '@/api/client';
import type { ComparisonRow } from '@/api/types/experiments';
import ComparisonControls from '@/components/comparison/ComparisonControls.vue';
import ComparisonLegend from '@/components/comparison/ComparisonLegend.vue';
import SecondaryMetricsPanel from '@/components/comparison/SecondaryMetricsPanel.vue';
import StatisticsPanel from '@/components/comparison/StatisticsPanel.vue';
import TaskGrid from '@/components/comparison/TaskGrid.vue';
import type { GridSort } from '@/components/comparison/cells';
import { emptyFilterCopy, provisionalBanner, splitLead } from '@/components/comparison/readings';
import EmptyState from '@/components/ui/EmptyState.vue';
import ErrorBanner from '@/components/ui/ErrorBanner.vue';
import StatusDot from '@/components/ui/StatusDot.vue';
import { urlEnum, urlOptional, urlString, useUrlState } from '@/composables/useUrlState';
import { formatClock } from '@/lib/format';
import { ROUTE_NAMES } from '@/router';
import { useComparisonStore } from '@/stores/comparison';
import { useExperimentDetailStore } from '@/stores/experiment-detail';

const props = defineProps<{ experimentId: string }>();

const GRID_SORTS: readonly GridSort[] = ['delta', 'task'];

const route = useRoute();
const router = useRouter();
const store = useComparisonStore();
const detail = useExperimentDetailStore();

const url = useUrlState({
  candidate: urlOptional(),
  key: urlString(SCORE_KEY_PRIMARY),
  show: urlEnum(COMPARISON_FILTERS, 'all'),
  sort: urlEnum(GRID_SORTS, 'delta'),
});

const record = computed(() => store.records[props.experimentId] ?? null);
const view = computed(() => record.value?.view ?? null);
/**
 * The view on screen is for another candidate or key than the URL names, which is loading or
 * failed to load: the last view stays, dimmed, under the load error.
 */
const stale = computed(() => {
  const r = record.value;
  if (!r || !(r.loading || r.error) || !r.viewSelection) return false;
  return r.viewSelection.candidate !== url.candidate.value || r.viewSelection.key !== url.key.value;
});

watch(
  [() => props.experimentId, () => url.candidate.value, () => url.key.value],
  ([id, candidate, key]) => void store.load(id, { candidate, key }),
  { immediate: true },
);

// Live: run events patch their cell, a status change or a reconnect refetches.
const stopListening = detail.onRunEvent((event) => store.applyRunEvent(props.experimentId, event));
watch(
  () => detail.records[props.experimentId]?.status,
  (now, before) => {
    if (before !== undefined && now !== before) void store.refresh(props.experimentId);
  },
);
// After a drop or a background tab's pause, whatever the missed events changed.
watch(
  () => detail.reconnects,
  () => void store.refresh(props.experimentId),
);
onBeforeUnmount(() => {
  stopListening();
  store.release(props.experimentId);
});

const reason = computed(() => view.value?.statisticsUnavailable?.reason ?? null);
const unavailable = computed(() =>
  view.value?.statisticsUnavailable ? splitLead(view.value.statisticsUnavailable.message) : null,
);
/** Δ, Change and the filter need a per-task difference: two repetitions and a scored run. */
const hasChanges = computed(
  () => !!view.value && view.value.repetitions > 1 && reason.value !== 'nothing_scored',
);
const filter = computed(() => (hasChanges.value ? url.show.value : 'all'));

/** The experiment's suite version and task order, from the page's record. */
const suite = computed(() => detail.records[props.experimentId]?.suite ?? null);

const rows = computed<ComparisonRow[]>(() => {
  const v = view.value;
  if (!v) return [];
  let list = filter.value === 'all' ? v.rows : v.rows.filter((r) => r.change === filter.value);
  // Without a Δ (nothing scored yet) there is nothing to rank by: suite order then too.
  if ((url.sort.value === 'task' || !hasChanges.value) && suite.value) {
    const order = new Map(suite.value.tasks.map((t, i) => [t.key, i]));
    const at = (key: string) => order.get(key) ?? Number.MAX_SAFE_INTEGER;
    list = [...list].sort((a, b) => at(a.taskKey) - at(b.taskKey));
  }
  return list;
});

const hasCancelled = computed(() =>
  rows.value.some((r) => [...r.baseline, ...r.candidate].some((c) => c.runStatus === 'cancelled')),
);
const banner = computed(() => (view.value ? provisionalBanner(view.value) : null));
const emptyCopy = computed(() => (view.value ? emptyFilterCopy(filter.value, view.value) : null));
const showStatistics = computed(
  () =>
    !!view.value?.statistics ||
    reason.value === 'not_enough_runs' ||
    reason.value === 'too_few_tasks',
);
/** Secondary metrics wait for the experiment to settle, and need a counted run. */
const showSecondary = computed(
  () =>
    !!view.value &&
    !view.value.provisional &&
    reason.value !== 'nothing_scored' &&
    view.value.secondary.length > 0,
);

function taskRoute(taskKey: string): RouteLocationRaw | null {
  return suite.value
    ? { name: ROUTE_NAMES.task, params: { id: suite.value.suiteId, key: taskKey } }
    : null;
}

const duplicateRoute = computed<RouteLocationRaw>(() => ({
  name: ROUTE_NAMES.experimentNew,
  query: { from: props.experimentId, repetitions: '5' },
}));

/** Open a run in the inspector over this tab; J/K follow the grid as it is drawn. */
function openRun(runId: string): void {
  detail.setRunOrder(
    rows.value.flatMap((r) => [...r.baseline, ...r.candidate].map((c) => c.runId)),
  );
  void router.push({ query: { ...route.query, run: runId } });
}

function onSort(sort: GridSort): void {
  if (sort === 'delta') store.resort(props.experimentId);
  url.sort.value = sort;
}

function onCandidate(versionId: string): void {
  url.candidate.value = versionId;
}
function onKey(key: string): void {
  url.key.value = key;
}

function retry(): void {
  void store.load(props.experimentId, { candidate: url.candidate.value, key: url.key.value });
}

const error = computed(() => record.value?.error ?? null);
const errorText = computed(() => (error.value ? errorMessage(error.value) : null));
/** A 400 names a candidate or key this experiment does not have: offer the defaults. */
const badSelection = computed(
  () =>
    isApiError(error.value) &&
    error.value.status === 400 &&
    (url.candidate.value !== null || url.key.value !== SCORE_KEY_PRIMARY),
);
function useDefaults(): void {
  url.candidate.value = null;
  url.key.value = SCORE_KEY_PRIMARY;
}
/** The load error's hint, with or without a view on screen. */
const loadHint = computed(() =>
  badSelection.value
    ? 'The link names a candidate or score key this experiment does not have.'
    : 'The candidate select keeps its value; Retry reloads with it.',
);

const SKELETON_CELLS = 5;
</script>

<template>
  <div class="flex flex-col gap-16" data-testid="comparison-tab">
    <div v-if="!view && error" class="rounded-6 border border-border bg-surface px-16 py-12">
      <ErrorBanner
        compact
        title="Could not load the comparison"
        :detail="errorText"
        :hint="loadHint"
        retry-label="Retry"
        @retry="retry"
      >
        <template v-if="badSelection" #actions>
          <button type="button" class="btn sm" @click="useDefaults">Use the defaults</button>
        </template>
      </ErrorBanner>
    </div>

    <div
      v-else-if="!view"
      class="flex flex-col gap-10 rounded-6 border border-border bg-surface px-16 py-14"
      aria-busy="true"
      aria-label="Loading the comparison"
      data-testid="comparison-loading"
    >
      <div class="flex items-center gap-8" aria-hidden="true">
        <span
          v-for="w in [180, 200, 120]"
          :key="w"
          class="block h-10 animate-shimmer rounded-3 bg-surface-3"
          :style="{ width: `${w}px` }"
        />
      </div>
      <div v-for="w in [120, 110, 130]" :key="w" class="flex items-center gap-8" aria-hidden="true">
        <span
          class="block h-10 animate-shimmer rounded-3 bg-surface-3"
          :style="{ width: `${w}px` }"
        />
        <span
          v-for="i in SKELETON_CELLS"
          :key="i"
          class="block size-16 animate-shimmer rounded-3 bg-surface-3"
        />
        <span class="block h-10 w-40 animate-shimmer rounded-3 bg-surface-3" />
      </div>
      <span class="block h-40 w-full animate-shimmer rounded-3 bg-surface-3" aria-hidden="true" />
    </div>

    <template v-else>
      <ComparisonControls
        :view="view"
        :filter="filter"
        :show-filter="hasChanges"
        :selected-candidate="url.candidate.value"
        :selected-key="url.key.value"
        @update:candidate="onCandidate"
        @update:score-key="onKey"
        @update:filter="url.show.value = $event"
      />

      <!-- Another candidate or key failed to load: the load error over the dimmed last view. -->
      <ErrorBanner
        v-if="error && stale"
        compact
        title="Could not load the comparison"
        :detail="errorText"
        :hint="loadHint"
        retry-label="Retry"
        @retry="retry"
      >
        <template v-if="badSelection" #actions>
          <button type="button" class="btn sm" @click="useDefaults">Use the defaults</button>
        </template>
      </ErrorBanner>
      <ErrorBanner
        v-else-if="error"
        compact
        title="Could not refresh the comparison"
        :detail="errorText"
        :hint="`Showing data from ${formatClock(record?.loadedAt)}.`"
        retry-label="Retry"
        @retry="retry"
      />

      <div
        class="flex flex-col gap-16"
        :class="{ 'opacity-60': stale }"
        :aria-busy="stale ? 'true' : undefined"
      >
        <div
          v-if="view.provisional && reason !== 'nothing_scored' && banner"
          role="status"
          class="flex items-center gap-10 rounded-6 border border-dashed border-border-strong bg-surface px-12 py-8"
          data-testid="provisional-banner"
        >
          <StatusDot
            :tone="
              view.experimentStatus === 'failed'
                ? 'err'
                : view.experimentStatus === 'paused'
                  ? 'que'
                  : 'run'
            "
            :mode="
              view.experimentStatus === 'running'
                ? 'pulse'
                : view.experimentStatus === 'paused'
                  ? 'hollow'
                  : 'solid'
            "
          />
          <span class="text-text-2"
            ><b class="font-semibold text-text">{{ banner.lead }}</b> {{ banner.rest }}</span
          >
        </div>

        <section
          v-if="reason === 'nothing_scored'"
          class="overflow-hidden rounded-6 border border-border bg-surface"
          data-testid="nothing-scored"
        >
          <div class="flex flex-col items-start gap-6 border-b px-16 py-20">
            <div class="font-semibold">
              {{ view.provisional ? 'Nothing to compare yet' : 'Nothing to compare' }}
            </div>
            <p class="text-text-2">{{ view.statisticsUnavailable?.message }}</p>
          </div>
          <TaskGrid
            bare
            :rows="rows"
            :baseline="view.baseline.name"
            :candidate="view.candidate.name"
            :repetitions="view.repetitions"
            :show-delta="false"
            :sortable="false"
            :provisional="view.provisional"
            :task-route="taskRoute"
            @open="openRun"
          />
        </section>

        <section
          v-else-if="reason === 'single_repetition'"
          class="overflow-hidden rounded-6 border border-border bg-surface"
          data-testid="single-repetition"
        >
          <TaskGrid
            bare
            dense
            :rows="rows"
            :baseline="view.baseline.name"
            :candidate="view.candidate.name"
            :repetitions="view.repetitions"
            :show-delta="false"
            :sortable="false"
            :provisional="view.provisional"
            :task-route="taskRoute"
            @open="openRun"
          />
          <div
            class="flex flex-wrap items-center justify-between gap-x-16 gap-y-10 border-t bg-surface-2 px-16 py-14"
          >
            <p v-if="unavailable" class="max-w-420 text-text-2">
              <b class="font-semibold text-text">{{ unavailable.lead }}</b> {{ unavailable.rest }}
            </p>
            <RouterLink class="btn primary" :to="duplicateRoute"
              >Duplicate with 5 repetitions</RouterLink
            >
          </div>
        </section>

        <EmptyState
          v-else-if="rows.length === 0 && emptyCopy"
          :title="emptyCopy.title"
          :body="emptyCopy.body"
          data-testid="empty-filter"
        >
          <template #actions>
            <button type="button" class="btn" @click="url.show.value = 'all'">
              Show all tasks
            </button>
          </template>
        </EmptyState>

        <TaskGrid
          v-else
          :rows="rows"
          :baseline="view.baseline.name"
          :candidate="view.candidate.name"
          :repetitions="view.repetitions"
          :show-delta="hasChanges"
          :sortable="hasChanges"
          :sort="url.sort.value"
          :provisional="view.provisional"
          :task-route="taskRoute"
          @open="openRun"
          @sort="onSort"
        />

        <ComparisonLegend :provisional="view.provisional" :cancelled="hasCancelled" />

        <div
          v-if="showStatistics || showSecondary"
          class="grid grid-cols-[repeat(auto-fit,minmax(min(560px,100%),1fr))] items-start gap-16"
        >
          <StatisticsPanel v-if="showStatistics" :view="view" />
          <SecondaryMetricsPanel v-if="showSecondary" :view="view" />
        </div>
      </div>
    </template>
  </div>
</template>
