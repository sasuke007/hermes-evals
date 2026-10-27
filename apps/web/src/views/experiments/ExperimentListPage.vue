<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import { EXPERIMENT_STATUSES, type ExperimentStatus } from '@hermes-evals/shared';
import type { ProviderInfo } from '@/api/types/system';
import ExperimentListTable from '@/components/experiment-list/ExperimentListTable.vue';
import KeySetupCard from '@/components/experiment-list/KeySetupCard.vue';
import SampleExperimentButton from '@/components/experiment-list/SampleExperimentButton.vue';
import { experimentCount, matchesSearch } from '@/components/experiment-list/listText';
import PageContainer from '@/components/layout/PageContainer.vue';
import SetupCard from '@/components/model-access/SetupCard.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import ErrorBanner from '@/components/ui/ErrorBanner.vue';
import PageHeader from '@/components/ui/PageHeader.vue';
import SegmentedControl from '@/components/ui/SegmentedControl.vue';
import type { SegmentOption } from '@/components/ui/types';
import { usePolling } from '@/composables/usePolling';
import { urlEnum, urlSort, urlString, useUrlState } from '@/composables/useUrlState';
import { formatClock } from '@/lib/format';
import { ROUTE_NAMES } from '@/router';
import { LIST_POLL_INTERVAL_MS, useExperimentsStore } from '@/stores/experiments';
import { useProvidersStore } from '@/stores/providers';

/**
 * Experiments (ExperimentList board, ExperimentStates list frames, UI_FLOWS 14.1): every
 * experiment, newest first, with live progress while something runs (a poll every 5 s, rows
 * patched in place), status chips with their reason, and one verdict chip per candidate once
 * completed. The status filter, the search and the sort live in the URL.
 *
 * Above the toolbar: SetupCard when no provider is connected (merged into the empty state when
 * there are no experiments yet), or the API-key card when the only provider the
 * configurations use has no key. A failed refresh keeps the rows, dimmed, under an
 * ErrorBanner; a failed first load shows the banner alone. With no experiment yet, the empty
 * state offers "Run a sample experiment" (Phase 8 G4), disabled with its reason until the
 * seeded sample configurations and invoices-v1 are there.
 */
type StatusFilter = 'all' | ExperimentStatus;
const STATUS_FILTERS = ['all', ...EXPERIMENT_STATUSES] as const;
/** After this long, a first load says the API is slow (ExperimentStates › loading). */
const SLOW_AFTER_MS = 10_000;

const store = useExperimentsStore();
const providers = useProvidersStore();

const url = useUrlState({
  q: urlString(''),
  status: urlEnum<StatusFilter>(STATUS_FILTERS, 'all'),
  sort: urlSort({ key: 'createdAt', dir: 'desc' }, ['createdAt']),
});

const rows = computed(() => store.listRows);
const searched = computed(() => rows.value.filter((row) => matchesSearch(row, url.q.value)));
const shown = computed(() =>
  url.status.value === 'all'
    ? searched.value
    : searched.value.filter((row) => row.status === url.status.value),
);
const filtered = computed(() => url.q.value.trim() !== '' || url.status.value !== 'all');

const filterOptions = computed<SegmentOption<StatusFilter>[]>(() =>
  STATUS_FILTERS.map((value) => ({
    value,
    label: value === 'all' ? 'All' : value,
    // No counts until the list has loaded: "All 0" would be a claim.
    count: !store.listLoaded
      ? null
      : value === 'all'
        ? rows.value.length
        : rows.value.filter((r) => r.status === value).length,
  })),
);

const firstLoad = computed(() => !store.listLoaded);
const loadFailed = computed(() => firstLoad.value && store.listError !== null);
const refreshFailed = computed(() => store.listLoaded && store.listError !== null);
const empty = computed(() => store.listLoaded && rows.value.length === 0);
/** The answer did not match its contract: a version mismatch, not a stopped service. */
const contractError = computed(() => store.listErrorKind === 'contract');

/** The configurations use only API-key providers, and none of them has its key. */
const keyBlocker = computed<ProviderInfo | null>(() => {
  if (!providers.loaded) return null;
  const used = providers.providers.filter((p) => p.usedBy.length > 0);
  if (used.length === 0 || used.some((p) => p.id === 'nous')) return null;
  if (used.some((p) => p.status === 'configured')) return null;
  return used.find((p) => p.authMethod === 'env-key' && p.status === 'missing') ?? null;
});
/** No experiments and no model: the setup card becomes the empty state (Flow A step 1). */
const emptyMerged = computed(
  () => empty.value && providers.loaded && !providers.anyConnected && !keyBlocker.value,
);

/** "1 suite loaded · 0 configurations" under the empty state. */
const prerequisites = computed(() => {
  const options = store.options;
  if (!options) return null;
  const suites = options.suites.length;
  const configs = options.configurations.length;
  return `${suites} ${suites === 1 ? 'suite' : 'suites'} loaded · ${configs} ${configs === 1 ? 'configuration' : 'configurations'}`;
});

const slow = ref(false);
let slowTimer: ReturnType<typeof setTimeout> | null = null;
watch(
  () => store.listLoading && firstLoad.value,
  (waiting) => {
    if (slowTimer !== null) clearTimeout(slowTimer);
    slowTimer = null;
    slow.value = false;
    if (waiting) slowTimer = setTimeout(() => (slow.value = true), SLOW_AFTER_MS);
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  if (slowTimer !== null) clearTimeout(slowTimer);
});

// Live rows: poll while anything runs (U3).
usePolling(
  () => store.refreshList(),
  LIST_POLL_INTERVAL_MS,
  () => store.listLoaded && store.anyRunning,
);

// The empty state's prerequisites line, fetched on every visit that shows it: the user may
// have loaded a suite or made configurations since (Flow A).
watch(
  empty,
  (isEmpty) => {
    if (isEmpty && !store.optionsLoading) void store.loadOptions();
  },
  { immediate: true },
);

function clearFilters(): void {
  url.q.value = '';
  url.status.value = 'all';
}

onMounted(() => {
  void store.loadList();
});
</script>

<template>
  <PageContainer variant="list">
    <PageHeader title="Experiments" :count="store.listLoaded ? experimentCount(rows.length) : null">
      <template #actions>
        <RouterLink :to="{ name: ROUTE_NAMES.experimentNew }" class="btn primary">
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <path
              d="M7 2.5v9M2.5 7h9"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linecap="round"
            />
          </svg>
          New experiment
        </RouterLink>
      </template>
    </PageHeader>

    <KeySetupCard v-if="keyBlocker" :provider="keyBlocker" />
    <SetupCard v-else-if="!emptyMerged" />

    <ErrorBanner
      v-if="loadFailed"
      title="Could not load experiments"
      :detail="store.listError"
      retry-label="Retry"
      @retry="store.loadList()"
    >
      <template #hint>
        <template v-if="contractError"
          >The <code>api</code> and <code>web</code> images are from different versions. Rebuild
          them: <code>docker compose up -d --build api web</code>.</template
        >
        <template v-else
          >Check <code>docker compose ps</code>: the <code>api</code> service should be
          running.</template
        >
      </template>
    </ErrorBanner>

    <SetupCard v-else-if="emptyMerged" variant="empty">
      <SampleExperimentButton align="start" />
    </SetupCard>

    <template v-else>
      <div v-if="!empty || filtered" class="flex flex-wrap items-center gap-12">
        <label class="relative flex items-center">
          <span class="sr-only">Search experiments</span>
          <svg
            width="14"
            height="14"
            viewBox="0 0 14 14"
            aria-hidden="true"
            class="absolute left-10 text-text-3"
          >
            <circle cx="6" cy="6" r="4.2" fill="none" stroke="currentColor" stroke-width="1.5" />
            <path
              d="M9.2 9.2L12 12"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
            />
          </svg>
          <input
            v-model="url.q.value"
            class="input w-320 pl-30 max-sm:w-full"
            type="search"
            placeholder="Filter by name, suite or configuration"
          />
        </label>
        <SegmentedControl
          v-model="url.status.value"
          :options="filterOptions"
          label="Status"
          size="md"
        />
        <div class="flex-1" />
        <span class="text-12 text-text-3">Newest first · live rows update in place</span>
      </div>

      <ErrorBanner
        v-if="refreshFailed"
        title="Could not refresh experiments"
        :detail="store.listError"
        retry-label="Retry"
        @retry="store.loadList()"
      >
        <template #hint>
          Showing data from {{ formatClock(store.listUpdatedAt) }}.
          <template v-if="contractError"
            >The <code>api</code> and <code>web</code> images are from different versions. Rebuild
            them: <code>docker compose up -d --build api web</code>.</template
          >
          <template v-else
            >Check <code>docker compose ps</code>: the <code>api</code> service should be
            running.</template
          >
        </template>
      </ErrorBanner>

      <ExperimentListTable
        v-model:sort="url.sort.value"
        :rows="shown"
        :loading="firstLoad"
        :stale="refreshFailed"
      >
        <template #empty>
          <EmptyState
            v-if="filtered && rows.length > 0"
            title="No experiments match these filters"
            :panel="false"
          >
            <template #actions>
              <button type="button" class="btn primary" @click="clearFilters">Clear filters</button>
            </template>
          </EmptyState>
          <EmptyState
            v-else
            title="No experiments yet"
            body="An experiment runs every task in a suite under two or more configurations, several times each, and tells you whether the candidate beat the baseline. You need a suite and at least two configurations to start."
            :panel="false"
          >
            <SampleExperimentButton class="mt-6" />
            <template #actions>
              <RouterLink :to="{ name: ROUTE_NAMES.experimentNew }" class="btn primary"
                >New experiment</RouterLink
              >
              <RouterLink :to="{ name: ROUTE_NAMES.configurations }" class="btn"
                >Set up configurations</RouterLink
              >
            </template>
            <template v-if="prerequisites" #footer>{{ prerequisites }}</template>
          </EmptyState>
        </template>
      </ExperimentListTable>
      <p v-if="slow" class="text-12 text-text-3" role="status">
        Still loading. The API is slow to respond
      </p>
    </template>
  </PageContainer>
</template>
