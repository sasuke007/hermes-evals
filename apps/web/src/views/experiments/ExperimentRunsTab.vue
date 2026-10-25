<script setup lang="ts">
/**
 * The Runs tab (Runs board, ExperimentStates; UI_FLOWS 17): every run of the experiment with
 * its filters and sort in the URL (?config=&task=&status=&score_status=&exec_error=1&
 * ungradable=1&sort=-duration), the count line with its shortcut chips, and the bulk bar
 * (Re-score, Retry execution) with the rules of components/runs/bulkRules.ts.
 *
 * Rows patch in place from the experiment's live stream (the page owns it); a new filter or
 * sort reloads in the API's order. A row opens the run in the inspector over the table, whose
 * J/K follows this filtered, sorted list.
 */
import { computed, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { RUN_SORT_KEYS, RUN_STATUSES, SCORE_STATUSES } from '@hermes-evals/shared';
import type { RunFilters } from '@/api/types/runs';
import BulkOutcomeBanner from '@/components/runs/BulkOutcomeBanner.vue';
import { emptyExplanation } from '@/components/runs/emptyRuns';
import RunsFilterBar from '@/components/runs/RunsFilterBar.vue';
import RunsTable from '@/components/runs/RunsTable.vue';
import RunsToolbar from '@/components/runs/RunsToolbar.vue';
import ErrorBanner from '@/components/ui/ErrorBanner.vue';
import { urlBool, urlSort, urlString, useUrlState } from '@/composables/useUrlState';
import { formatClock } from '@/lib/format';
import { ROUTE_NAMES } from '@/router';
import { useExperimentDetailStore } from '@/stores/experiment-detail';
import { useRunsStore } from '@/stores/runs';

const props = defineProps<{ experimentId: string }>();

const router = useRouter();
const runs = useRunsStore();
const detailStore = useExperimentDetailStore();
const detail = computed(() => detailStore.records[props.experimentId] ?? null);

// ── filters and sort, mirrored in the URL ──────────────────────────────────
const url = useUrlState({
  config: urlString('all'),
  task: urlString('all'),
  status: urlString('any'),
  score_status: urlString('any'),
  exec_error: urlBool(false),
  ungradable: urlBool(false),
  sort: urlSort({ key: 'task', dir: 'asc' }, RUN_SORT_KEYS),
});

const filterState = computed(() => ({
  config: url.config.value,
  task: url.task.value,
  status: url.status.value,
  scoreStatus: url.score_status.value,
  execError: url.exec_error.value,
  ungradable: url.ungradable.value,
}));

const isRunStatus = (v: string): v is (typeof RUN_STATUSES)[number] =>
  (RUN_STATUSES as readonly string[]).includes(v);
const isScoreStatus = (v: string): v is (typeof SCORE_STATUSES)[number] =>
  (SCORE_STATUSES as readonly string[]).includes(v);
const isSortKey = (v: string): v is (typeof RUN_SORT_KEYS)[number] =>
  (RUN_SORT_KEYS as readonly string[]).includes(v);

/** What the API is asked for. */
const filters = computed<RunFilters>(() => {
  const f = filterState.value;
  const out: RunFilters = {};
  if (f.config !== 'all') out.configuration = f.config;
  if (f.task !== 'all') out.task = f.task;
  if (isRunStatus(f.status)) out.status = f.status;
  if (isScoreStatus(f.scoreStatus)) out.scoreStatus = f.scoreStatus;
  if (f.execError) out.hasExecutionError = true;
  if (f.ungradable) out.ungradable = true;
  const sort = url.sort.value;
  if (sort && isSortKey(sort.key)) {
    out.sort = sort.key;
    out.dir = sort.dir;
  }
  return out;
});

const selected = ref<string[]>([]);
watch(
  [() => props.experimentId, () => JSON.stringify(filters.value)],
  () => {
    selected.value = [];
    void runs.load(props.experimentId, filters.value);
  },
  { immediate: true },
);

function clearFilters(): void {
  url.reset();
}
function toggleExecError(): void {
  const on = !url.exec_error.value;
  url.exec_error.value = on;
  if (on) url.ungradable.value = false;
}
function toggleUngradable(): void {
  const on = !url.ungradable.value;
  url.ungradable.value = on;
  if (on) url.exec_error.value = false;
}

// ── what the selects offer ──────────────────────────────────────────────────
const configurations = computed(() => {
  const d = detail.value;
  if (d) return [d.baseline.name, ...d.candidates.map((c) => c.name)];
  return [...new Set(runs.rows.map((r) => r.configuration.name))];
});
const tasks = computed(() => {
  const d = detail.value;
  if (d) return d.suite.tasks.map((t) => t.key);
  return [...new Set(runs.rows.map((r) => r.taskKey))];
});

// ── rows, selection, the inspector ───────────────────────────────────────────
const rows = computed(() => (runs.experimentId === props.experimentId ? runs.rows : []));
const selectedRows = computed(() =>
  selected.value.map((id) => runs.records[id]).filter((r) => r !== undefined),
);
// A row that left the list leaves the selection.
watch(rows, (list) => {
  const ids = new Set(list.map((r) => r.id));
  if (selected.value.some((id) => !ids.has(id))) {
    selected.value = selected.value.filter((id) => ids.has(id));
  }
});
watch(
  () => rows.value.map((r) => r.id).join(','),
  () => detailStore.setRunOrder(rows.value.map((r) => r.id)),
  { immediate: true },
);

function openRun(runId: string): void {
  void router.push({
    name: ROUTE_NAMES.experimentRun,
    params: { id: props.experimentId, runId },
    query: router.currentRoute.value.query,
  });
}

async function rescore(): Promise<void> {
  const result = await runs.rescore(selected.value);
  if (result) selected.value = [];
}
async function retry(): Promise<void> {
  const result = await runs.retry(selected.value);
  if (result) selected.value = [];
}

// ── loading, errors, empty ─────────────────────────────────────────────────
const firstLoad = computed(() => !runs.loaded || runs.experimentId !== props.experimentId);
const loadFailed = computed(() => !!runs.error && firstLoad.value);
const refreshFailed = computed(() => !!runs.error && !firstLoad.value);
const shown = computed(() => rows.value.length);
const empty = computed(() =>
  emptyExplanation(filterState.value, detail.value?.perConfiguration ?? null, runs.summary),
);
</script>

<template>
  <section class="flex flex-col gap-14" aria-label="Runs">
    <RunsFilterBar
      v-model:config="url.config.value"
      v-model:task="url.task.value"
      v-model:status="url.status.value"
      v-model:score-status="url.score_status.value"
      v-model:exec-error="url.exec_error.value"
      v-model:ungradable="url.ungradable.value"
      :configurations="configurations"
      :tasks="tasks"
      @clear="clearFilters"
    />

    <ErrorBanner
      v-if="loadFailed"
      title="Could not load runs"
      :detail="runs.error"
      hint="Filters and sort stay in the URL, so Retry loads the same view."
      retry-label="Retry"
      data-testid="runs-error"
      @retry="runs.load(experimentId, filters)"
    />
    <template v-else>
      <ErrorBanner
        v-if="refreshFailed"
        title="Could not refresh runs"
        :detail="runs.error"
        :hint="`Showing data from ${formatClock(runs.loadedAt)}. Filters and sort stay in the URL, so Retry loads the same view.`"
        retry-label="Retry"
        data-testid="runs-refresh-error"
        @retry="runs.load(experimentId, filters)"
      />
      <RunsToolbar
        :summary="runs.summary"
        :shown="shown"
        :selected="selectedRows"
        :busy="runs.busy"
        :exec-error="url.exec_error.value"
        :ungradable="url.ungradable.value"
        @rescore="rescore"
        @retry="retry"
        @clear-selection="selected = []"
        @toggle-exec-error="toggleExecError"
        @toggle-ungradable="toggleUngradable"
      />
      <BulkOutcomeBanner
        :outcome="runs.outcome"
        :error="runs.bulkError"
        :records="runs.records"
        @dismiss="runs.dismissOutcome()"
      />
      <RunsTable
        v-model:selected="selected"
        v-model:sort="url.sort.value"
        :rows="rows"
        :experiment-id="experimentId"
        :loading="firstLoad && runs.loading"
        :stale="refreshFailed"
        @open="openRun"
      >
        <template #empty>
          <div
            class="flex flex-col items-center gap-8 px-24 py-36 text-center"
            data-testid="runs-empty"
          >
            <div class="text-15 font-semibold">No runs match these filters</div>
            <p class="max-w-420 text-text-2">
              <template v-for="(part, i) in empty" :key="i"
                ><span v-if="part.code" class="font-mono">{{ part.text }}</span
                ><template v-else>{{ part.text }}</template></template
              >
            </p>
            <button type="button" class="btn primary mt-4" @click="clearFilters">
              Clear filters
            </button>
          </div>
        </template>
      </RunsTable>
    </template>
  </section>
</template>
