/**
 * The Runs tab (UI_FLOWS 17): one experiment's runs as records keyed by id, in the order the
 * API sorted them, with the count line over the whole experiment, and the bulk Re-score and
 * Retry execution.
 *
 * Live updates come from the experiment's event stream, which the experiment-detail store
 * owns: each `run` event patches its row in place, so rows never reorder or disappear while
 * live, even when a row stops matching the filters (Flow B: the retried row turns queued, then
 * running, under "Has execution error"). What an event does not carry (duration, tokens, cost,
 * the count line) comes from a quiet reload a few seconds later, which keeps the order of the
 * rows already shown. A new filter or sort reloads in the API's order.
 */
import { defineStore } from 'pinia';
import { computed, ref, shallowRef } from 'vue';
import { errorMessage, isApiError } from '@/api/client';
import { listRuns, rescoreRuns, retryRuns } from '@/api/runs';
import { apiMode } from '@/api/source';
import type {
  BulkRescoreResult,
  BulkRunActionResult,
  RunFilters,
  RunRow,
  RunSummaryCounts,
} from '@/api/types/runs';
import type { RunStatusEvent } from '@hermes-evals/shared';

/** How long after a finished run the table reloads its measured columns and count line. */
export const RUNS_REFRESH_DELAY_MS = 3_000;

export type BulkAction = 'rescore' | 'retry';

/** A bulk request that failed outright: the API's message, and its field issues if any. */
export interface BulkError {
  action: BulkAction;
  message: string;
  /** "runIds: select at most 500 runs" (a 400's issues), or null. */
  issues: string | null;
}

/** A refused request's field issues, as one line. */
function issuesOf(err: unknown): string | null {
  if (!isApiError(err) || err.issues.length === 0) return null;
  return err.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ');
}

/** A bulk action's answer, kept for the banner under the bulk bar. */
export interface BulkOutcome {
  action: BulkAction;
  /** How many runs were asked for. */
  requested: number;
  enqueued: string[];
  refused: BulkRunActionResult['refused'];
}

/**
 * Statuses after which a run's measured columns are final until a retry (the API's measured
 * statuses: scoring comes after execution, so its duration, tokens and cost are known).
 */
const SETTLED = new Set(['executed', 'scoring', 'scored', 'execution_error', 'cancelled']);
/** Statuses of a run that is (again) waiting or executing: it has no figures of its own yet. */
const RESTARTED = new Set(['queued', 'running']);

function sameFilters(a: RunFilters, b: RunFilters): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export const useRunsStore = defineStore('runs', () => {
  /** The experiment the rows belong to. */
  const experimentId = ref<string | null>(null);
  const filters = shallowRef<RunFilters>({});
  /** Rows by run id. */
  const records = ref<Record<string, RunRow>>({});
  /** Run ids in display order. */
  const order = ref<string[]>([]);
  const summary = ref<RunSummaryCounts | null>(null);
  /** Rows matching the filters at the last load (the API's count). */
  const matched = ref(0);
  const loading = ref(false);
  const loaded = ref(false);
  const error = ref<string | null>(null);
  /** When the last load succeeded: the ErrorBanner's "Showing data from …". */
  const loadedAt = ref<string | null>(null);

  const busy = ref<BulkAction | null>(null);
  const outcome = ref<BulkOutcome | null>(null);
  const bulkError = ref<BulkError | null>(null);

  let loadToken = 0;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;

  /** The rows in display order. */
  const rows = computed<RunRow[]>(() =>
    order.value.map((id) => records.value[id]).filter((r): r is RunRow => r !== undefined),
  );

  function clearRefresh(): void {
    if (refreshTimer !== null) clearTimeout(refreshTimer);
    refreshTimer = null;
  }

  /**
   * Loads the runs of an experiment with these filters and sort. `keepOrder` (a quiet reload
   * while live) keeps the rows already shown where they are and appends new ones.
   */
  async function load(
    id: string,
    nextFilters: RunFilters = {},
    options: { keepOrder?: boolean } = {},
  ): Promise<void> {
    const token = ++loadToken;
    const sameView = id === experimentId.value && sameFilters(nextFilters, filters.value);
    if (id !== experimentId.value) {
      // Another experiment: nothing of the last one may show while this one loads.
      records.value = {};
      order.value = [];
      summary.value = null;
      loaded.value = false;
    }
    experimentId.value = id;
    filters.value = nextFilters;
    loading.value = true;
    try {
      const result = await listRuns(id, nextFilters);
      if (token !== loadToken) return;
      const next: Record<string, RunRow> = {};
      for (const row of result.rows) next[row.id] = row;
      if (options.keepOrder && sameView) {
        // Keep every row on screen (a live row may no longer match the filters).
        const kept = order.value.filter((rid) => rid in next || rid in records.value);
        const known = new Set(kept);
        records.value = { ...records.value, ...next };
        order.value = [...kept, ...result.rows.map((r) => r.id).filter((rid) => !known.has(rid))];
      } else {
        records.value = next;
        order.value = result.rows.map((r) => r.id);
      }
      summary.value = result.summary;
      matched.value = result.matched;
      loaded.value = true;
      loadedAt.value = new Date().toISOString();
      error.value = null;
    } catch (err) {
      if (token !== loadToken) return;
      error.value = errorMessage(err);
    } finally {
      if (token === loadToken) loading.value = false;
    }
  }

  /** Reloads the current view keeping its order (live updates, after a bulk action). */
  function refresh(): Promise<void> {
    if (!experimentId.value) return Promise.resolve();
    return load(experimentId.value, filters.value, { keepOrder: true });
  }

  /** A quiet reload a few seconds from now, once (more events in the meantime join it). */
  function scheduleRefresh(delayMs = RUNS_REFRESH_DELAY_MS): void {
    if (refreshTimer !== null || !experimentId.value) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      void refresh();
    }, delayMs);
  }

  /**
   * A `run` event from the experiment stream: patch the row in place. A run that went back to
   * queued or running has no measured figures of its own yet; a run that settled gets them
   * from the next quiet reload.
   */
  function applyRunEvent(event: RunStatusEvent): void {
    const row = records.value[event.runId];
    if (!row) {
      if (SETTLED.has(event.status)) scheduleRefresh();
      return;
    }
    const restarted = RESTARTED.has(event.status);
    records.value[event.runId] = {
      ...row,
      status: event.status,
      attempts: event.attempt,
      primaryScore: event.primaryScore,
      finishedAt: event.finishedAt,
      generation: event.generation,
      rescorePending: event.rescorePending,
      ...(restarted
        ? { executionErrorCategory: null, durationS: null, tokens: null, costUsd: null }
        : {}),
    };
    if (SETTLED.has(event.status)) scheduleRefresh();
  }

  function settle(action: BulkAction, requested: string[], result: BulkRunActionResult): void {
    outcome.value = {
      action,
      requested: requested.length,
      enqueued: result.enqueued,
      refused: result.refused,
    };
  }

  /** Live: reload the rows soon. Fixtures are static, so a reload would undo the change. */
  function afterBulk(): void {
    if (apiMode === 'live') scheduleRefresh();
  }

  /**
   * POST /experiments/:id/runs/rescore. Accepted runs keep their result and show the pending
   * re-score until the new generation publishes; refused ones are listed in `outcome`.
   */
  async function rescore(runIds: string[]): Promise<BulkRescoreResult | null> {
    const id = experimentId.value;
    if (!id || runIds.length === 0) return null;
    busy.value = 'rescore';
    bulkError.value = null;
    outcome.value = null;
    try {
      const result = await rescoreRuns(id, runIds);
      for (const runId of result.enqueued) {
        const row = records.value[runId];
        if (row) records.value[runId] = { ...row, rescorePending: true };
      }
      settle('rescore', runIds, result);
      afterBulk();
      return result;
    } catch (err) {
      bulkError.value = { action: 'rescore', message: errorMessage(err), issues: issuesOf(err) };
      return null;
    } finally {
      busy.value = null;
    }
  }

  /** POST /experiments/:id/runs/retry: accepted runs go back to queued with the next attempt. */
  async function retry(runIds: string[]): Promise<BulkRunActionResult | null> {
    const id = experimentId.value;
    if (!id || runIds.length === 0) return null;
    busy.value = 'retry';
    bulkError.value = null;
    outcome.value = null;
    try {
      const result = await retryRuns(id, runIds);
      for (const runId of result.enqueued) {
        const row = records.value[runId];
        if (row) {
          records.value[runId] = {
            ...row,
            status: 'queued',
            executionErrorCategory: null,
            durationS: null,
            tokens: null,
            costUsd: null,
            finishedAt: null,
          };
        }
      }
      settle('retry', runIds, result);
      afterBulk();
      return result;
    } catch (err) {
      bulkError.value = { action: 'retry', message: errorMessage(err), issues: issuesOf(err) };
      return null;
    } finally {
      busy.value = null;
    }
  }

  function dismissOutcome(): void {
    outcome.value = null;
    bulkError.value = null;
  }

  /** Forget everything (leaving the experiment). */
  function reset(): void {
    clearRefresh();
    loadToken++;
    experimentId.value = null;
    filters.value = {};
    records.value = {};
    order.value = [];
    summary.value = null;
    matched.value = 0;
    loading.value = false;
    loaded.value = false;
    error.value = null;
    loadedAt.value = null;
    busy.value = null;
    outcome.value = null;
    bulkError.value = null;
  }

  return {
    experimentId,
    filters,
    records,
    order,
    rows,
    summary,
    matched,
    loading,
    loaded,
    error,
    loadedAt,
    busy,
    outcome,
    bulkError,
    load,
    refresh,
    scheduleRefresh,
    applyRunEvent,
    rescore,
    retry,
    dismissOutcome,
    reset,
  };
});
