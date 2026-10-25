/**
 * One experiment's detail (UI_FLOWS 14.2 and 15): the record behind the experiment page's
 * header and its Overview tab, its live event stream, and the experiment controls.
 *
 * Records are keyed by experiment id. `open(id)` loads the record and starts
 * GET /experiments/:id/events, the one stream of the page: `counts` and `feed` patch the
 * record in place, `experiment` patches the status and refetches the record (aggregates, times
 * and the VerdictCard's history change with it), and `run` events go to the runs store and to
 * whoever listens through onRunEvent (the comparison grid, the inspector header). What no
 * event carries (per-configuration bars, provisional verdicts) comes from a refetch a few
 * seconds after the counts move. When the stream drops the values freeze, the indicator says
 * so, and on reconnect (after a drop, or after a background tab let the stream go) the record
 * and the Runs tab's rows are refetched, since the API does not replay events; `reconnects`
 * counts those moments for the tabs that keep their own data (the comparison).
 *
 * Fixtures mode streams nothing and draws the stream as live; ?scenario=stream-lost draws it
 * reconnecting at attempt 3, as the AppShell does.
 */
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { errorMessage } from '@/api/client';
import {
  cancelExperiment,
  EXPERIMENT_EVENT_NAMES,
  ExperimentEventSchema,
  experimentEventsPath,
  getExperiment,
  pauseExperiment,
  resumeExperiment,
  retryFailedRuns,
} from '@/api/experiments';
import { apiMode, hasScenario } from '@/api/source';
import type {
  ExperimentActionResult,
  ExperimentDetail,
  ExperimentEvent,
} from '@/api/types/experiments';
import type { LiveState } from '@/components/ui/types';
import { useSse, type SseState } from '@/composables/useSse';
import type { RunStatusEvent } from '@hermes-evals/shared';
import { useRunsStore } from './runs';

/** After the counts move, the record is refetched at most this often. */
export const DETAIL_REFRESH_DELAY_MS = 5_000;

export type ExperimentAction = 'pause' | 'resume' | 'cancel' | 'retry-failed';
export type RunEventListener = (event: RunStatusEvent) => void;

export const useExperimentDetailStore = defineStore('experiment-detail', () => {
  const records = ref<Record<string, ExperimentDetail>>({});
  /** The experiment the page shows; its stream is the one open. */
  const currentId = ref<string | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);
  /** When each record was fetched (epoch ms): the elapsed clock counts on from there. */
  const fetchedAt = ref<Record<string, number>>({});
  /** When the last live event arrived ("Live · updated 15:23:42"). */
  const lastEventAt = ref<string | null>(null);
  /** Feed rows that arrived live, drawn with the arrival highlight. */
  const arrivedRunIds = ref<string[]>([]);
  /** The run ids the inspector steps through with J/K, set by the tab that opened it. */
  const runOrder = ref<string[]>([]);

  const acting = ref<ExperimentAction | null>(null);
  const actionError = ref<{ action: ExperimentAction; message: string } | null>(null);

  const listeners = new Set<RunEventListener>();
  let loadToken = 0;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  let verdictUpdatedAt: string | null | undefined;
  /** Fixtures mode, ?scenario=stream-lost: the stream is drawn reconnecting. */
  const streamLost = ref(false);
  /** How often the stream came back after missing events: tabs watch it to refetch. */
  const reconnects = ref(0);

  const current = computed<ExperimentDetail | null>(() =>
    currentId.value ? (records.value[currentId.value] ?? null) : null,
  );

  const live = useSse(
    () => (currentId.value ? experimentEventsPath(currentId.value) : null),
    ExperimentEventSchema,
    {
      events: EXPERIMENT_EVENT_NAMES,
      immediate: false,
      onEvent: (event) => apply(event),
      onReconnect: () => reconnected(),
    },
  );

  /** The stream is back: refetch what the missed events changed. */
  function reconnected(): void {
    reconnects.value++;
    void refresh();
    const runs = useRunsStore();
    if (runs.experimentId !== null && runs.experimentId === currentId.value) void runs.refresh();
  }

  /** The stream as the page draws it; fixtures mode stands in a live one. */
  const liveState = computed<SseState>(() => {
    if (apiMode === 'fixtures') return streamLost.value ? 'reconnecting' : 'live';
    return live.state.value;
  });
  const liveAttempt = computed(() => (streamLost.value ? 3 : live.attempt.value));
  const liveIndicator = computed<LiveState>(() => {
    switch (liveState.value) {
      case 'reconnecting':
        return 'reconnecting';
      case 'offline':
        return 'offline';
      default:
        return 'live';
    }
  });
  /** Values are frozen at the last update while the stream is down. */
  const frozen = computed(
    () => liveState.value === 'reconnecting' || liveState.value === 'offline',
  );

  async function load(id: string): Promise<void> {
    const token = ++loadToken;
    loading.value = true;
    try {
      const detail = await getExperiment(id);
      if (token !== loadToken) return;
      records.value[id] = detail;
      fetchedAt.value[id] = Date.now();
      if (id === currentId.value && detail.lastEventAt) {
        const seen = lastEventAt.value;
        if (!seen || Date.parse(detail.lastEventAt) > Date.parse(seen)) {
          lastEventAt.value = detail.lastEventAt;
        }
      }
      error.value = null;
    } catch (err) {
      if (token !== loadToken) return;
      error.value = errorMessage(err);
    } finally {
      if (token === loadToken) loading.value = false;
    }
  }

  /** Refetch the record on screen (Retry, reconnect, a status change). */
  function refresh(): Promise<void> {
    if (refreshTimer !== null) clearTimeout(refreshTimer);
    refreshTimer = null;
    return currentId.value ? load(currentId.value) : Promise.resolve();
  }

  function scheduleRefresh(delayMs = DETAIL_REFRESH_DELAY_MS): void {
    if (refreshTimer !== null || !currentId.value) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      void refresh();
    }, delayMs);
  }

  /** Show an experiment: load it and open its stream (closing any other). */
  function open(id: string): Promise<void> {
    if (currentId.value !== id) {
      close();
      currentId.value = id;
      lastEventAt.value = records.value[id]?.lastEventAt ?? null;
    }
    streamLost.value = apiMode === 'fixtures' && hasScenario('stream-lost');
    live.start();
    return load(id);
  }

  /** Leave the page: stop the stream. Records stay for the next visit. */
  function close(): void {
    live.stop();
    if (refreshTimer !== null) clearTimeout(refreshTimer);
    refreshTimer = null;
    loadToken++;
    loading.value = false;
    error.value = null;
    currentId.value = null;
    arrivedRunIds.value = [];
    runOrder.value = [];
    actionError.value = null;
    verdictUpdatedAt = undefined;
  }

  /** One event of the stream, patched into the record in place. */
  function apply(event: ExperimentEvent): void {
    const id = currentId.value;
    const record = id ? records.value[id] : undefined;
    lastEventAt.value = event.at;
    switch (event.type) {
      case 'counts':
        if (record) {
          record.counts = event.counts;
          record.spend = event.spend;
        }
        scheduleRefresh();
        break;
      case 'feed':
        if (record) {
          const rest = record.feed.filter((f) => f.runId !== event.entry.runId);
          record.feed = [event.entry, ...rest].slice(0, 10);
          arrivedRunIds.value = [event.entry.runId, ...arrivedRunIds.value].slice(0, 10);
        }
        break;
      case 'experiment': {
        const moved =
          !record ||
          record.status !== event.status ||
          record.pauseReason !== event.pauseReason ||
          (verdictUpdatedAt !== undefined && verdictUpdatedAt !== event.verdictUpdatedAt);
        verdictUpdatedAt = event.verdictUpdatedAt;
        if (record) {
          record.status = event.status;
          record.pauseReason = event.pauseReason;
          record.pausedAt = event.pauseReason ? (record.pausedAt ?? event.at) : null;
          record.failure = event.failure;
        }
        if (moved) void refresh();
        break;
      }
      case 'run':
        useRunsStore().applyRunEvent(event);
        for (const listener of listeners) listener(event);
        break;
    }
  }

  /** Listen to the stream's `run` events (the comparison grid, the inspector header). */
  function onRunEvent(listener: RunEventListener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  /** The order the inspector's J/K follows: the list the drawer was opened from. */
  function setRunOrder(ids: string[]): void {
    runOrder.value = ids;
  }

  /** Patch the record after a control succeeded, before (or instead of, in fixtures) a refetch. */
  function patchStatus(id: string, action: ExperimentAction, result: ExperimentActionResult): void {
    const record = records.value[id];
    if (!record) return;
    record.status = result.status;
    if (result.status === 'paused') {
      record.pauseReason = action === 'pause' ? 'user' : (record.pauseReason ?? 'user');
      record.pausedAt = record.pausedAt ?? new Date().toISOString();
    } else {
      record.pauseReason = null;
      record.pausedAt = null;
    }
    if (result.status !== 'failed') record.failure = null;
    // Cancel leaves a running experiment running while its in-flight runs finish.
    if (action === 'cancel') record.cancelledAt ??= new Date().toISOString();
  }

  async function control(
    action: ExperimentAction,
    call: (id: string) => Promise<ExperimentActionResult>,
  ): Promise<boolean> {
    const id = currentId.value;
    if (!id || acting.value) return false;
    acting.value = action;
    actionError.value = null;
    try {
      const result = await call(id);
      patchStatus(id, action, result);
      // Fixtures are static: a refetch would undo the change the page just showed.
      if (apiMode === 'live') await load(id);
      return true;
    } catch (err) {
      actionError.value = { action, message: errorMessage(err) };
      return false;
    } finally {
      acting.value = null;
    }
  }

  const pause = () => control('pause', pauseExperiment);
  /** A spend-ceiling pause resumes only with a higher ceiling. */
  const resume = (options: { spendCeilingUsd?: number } = {}) =>
    control('resume', (id) => resumeExperiment(id, options));
  const cancel = () => control('cancel', cancelExperiment);
  const retryFailed = () => control('retry-failed', retryFailedRuns);

  function clearActionError(): void {
    actionError.value = null;
  }

  return {
    records,
    currentId,
    current,
    loading,
    error,
    fetchedAt,
    lastEventAt,
    arrivedRunIds,
    runOrder,
    acting,
    actionError,
    liveState,
    liveAttempt,
    liveIndicator,
    frozen,
    reconnects,
    retryLive: live.retry,
    open,
    close,
    load,
    refresh,
    apply,
    onRunEvent,
    setRunOrder,
    pause,
    resume,
    cancel,
    retryFailed,
    clearActionError,
  };
});
