/**
 * The Comparison tab's data (plan 12.3, UI_FLOWS 16): per experiment, the ComparisonView for
 * the candidate and score key the URL names, kept between visits.
 *
 * The filter is not part of the request: the view is loaded for every task ('all') and the tab
 * filters its rows, so a filter click is instant; the API filters the same way and the counts
 * are the view's own. While the experiment is live, `run` events (from the experiment page's
 * one stream, useExperimentDetailStore().onRunEvent) patch their cell in place and a refetch
 * follows a moment later for what no event carries (rates, Δ, the statistics). A refetch keeps
 * the rows where they are, so nothing jumps while the user reads (U3); a change of candidate or
 * key, or a click on the Δ header, takes the API's order again.
 */
import { SCORE_KEY_PRIMARY, type RunStatusEvent } from '@hermes-evals/shared';
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { getComparison } from '@/api/experiments';
import type { ComparisonRow, ComparisonView, RepetitionCell } from '@/api/types/experiments';

/** A live event is followed by a refetch this much later (one per window, however many come). */
export const LIVE_REFRESH_MS = 1_500;

/** What the URL selects: a candidate version (null: the first) and a score key. */
export interface ComparisonSelection {
  candidate: string | null;
  key: string;
}

export interface ComparisonRecord {
  /** The selection being shown or loaded. */
  selection: ComparisonSelection;
  /** The last view that loaded, and the selection it was loaded for. */
  view: ComparisonView | null;
  viewSelection: ComparisonSelection | null;
  loading: boolean;
  /** The last load failed; `view` is still the last good one. */
  error: unknown;
  /** When `view` arrived (ISO). */
  loadedAt: string | null;
}

const sameSelection = (a: ComparisonSelection | null, b: ComparisonSelection): boolean =>
  a !== null && a.candidate === b.candidate && a.key === b.key;

/** The API's row order (view.ts sortRows): Δ descending, no Δ last, then the baseline rate, then the key. */
export function byDelta(a: ComparisonRow, b: ComparisonRow): number {
  return (
    (b.delta ?? -Infinity) - (a.delta ?? -Infinity) ||
    (a.passBaseline ?? 0) - (b.passBaseline ?? 0) ||
    (a.taskKey < b.taskKey ? -1 : a.taskKey > b.taskKey ? 1 : 0)
  );
}

/** `next` in the order of `previous`, rows it did not have after them in their own order. */
function keepOrder(next: ComparisonRow[], previous: readonly ComparisonRow[]): ComparisonRow[] {
  const at = new Map(previous.map((row, i) => [row.taskKey, i]));
  return next
    .map((row, i) => ({ row, rank: at.get(row.taskKey) ?? previous.length + i }))
    .sort((a, b) => a.rank - b.rank)
    .map(({ row }) => row);
}

function findCell(view: ComparisonView, runId: string): RepetitionCell | null {
  for (const row of view.rows) {
    const cell =
      row.baseline.find((c) => c.runId === runId) ?? row.candidate.find((c) => c.runId === runId);
    if (cell) return cell;
  }
  return null;
}

export const useComparisonStore = defineStore('comparison', () => {
  const records = ref<Record<string, ComparisonRecord>>({});
  const tokens = new Map<string, number>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  function recordOf(experimentId: string, selection: ComparisonSelection): ComparisonRecord {
    const existing = records.value[experimentId];
    if (existing) return existing;
    const record: ComparisonRecord = {
      selection,
      view: null,
      viewSelection: null,
      loading: false,
      error: null,
      loadedAt: null,
    };
    records.value[experimentId] = record;
    // The reactive copy, so the writes below reach the page.
    return records.value[experimentId] ?? record;
  }

  /**
   * Load the view for a selection. A newer load wins over one still in flight. `keepRows`
   * (a live refetch) keeps the rows in the order on screen.
   */
  async function load(
    experimentId: string,
    selection: ComparisonSelection,
    options: { keepRows?: boolean } = {},
  ): Promise<void> {
    const record = recordOf(experimentId, selection);
    record.selection = selection;
    record.loading = true;
    const token = (tokens.get(experimentId) ?? 0) + 1;
    tokens.set(experimentId, token);
    try {
      const view = await getComparison(experimentId, {
        candidate: selection.candidate ?? undefined,
        key: selection.key === SCORE_KEY_PRIMARY ? undefined : selection.key,
      });
      if (tokens.get(experimentId) !== token) return;
      const previous = record.view;
      if (options.keepRows && previous && sameSelection(record.viewSelection, selection)) {
        view.rows = keepOrder(view.rows, previous.rows);
      }
      record.view = view;
      record.viewSelection = { ...selection };
      record.loadedAt = new Date().toISOString();
      record.error = null;
    } catch (err) {
      if (tokens.get(experimentId) !== token) return;
      record.error = err;
    } finally {
      if (tokens.get(experimentId) === token) record.loading = false;
    }
  }

  /** Refetch what is on screen, keeping the rows in place (a live update, Retry). */
  function refresh(experimentId: string): Promise<void> {
    cancelRefresh(experimentId);
    const record = records.value[experimentId];
    if (!record) return Promise.resolve();
    return load(experimentId, record.selection, { keepRows: true });
  }

  /** Refetch once, `delayMs` from now; further calls in the meantime join it. */
  function scheduleRefresh(experimentId: string, delayMs = LIVE_REFRESH_MS): void {
    if (timers.has(experimentId) || !records.value[experimentId]) return;
    timers.set(
      experimentId,
      setTimeout(() => {
        timers.delete(experimentId);
        void refresh(experimentId);
      }, delayMs),
    );
  }

  function cancelRefresh(experimentId: string): void {
    const timer = timers.get(experimentId);
    if (timer !== undefined) clearTimeout(timer);
    timers.delete(experimentId);
  }

  /**
   * A run changed (the `run` event): its cell takes the new status at once, coloured by the
   * event's primary score when the primary key is selected; the rates and the statistics follow
   * with the refetch.
   */
  function applyRunEvent(experimentId: string, event: RunStatusEvent): void {
    const view = records.value[experimentId]?.view;
    if (!view) return;
    const cell = findCell(view, event.runId);
    if (!cell) return;
    cell.runStatus = event.status;
    cell.attempt = Math.max(event.attempt, 1);
    if (event.status !== 'scored') cell.scoreStatus = null;
    else if (view.scoreKey === SCORE_KEY_PRIMARY && event.primaryScore) {
      cell.scoreStatus = event.primaryScore.status;
    }
    if (event.status === 'queued' || event.status === 'running') cell.durationS = null;
    scheduleRefresh(experimentId);
  }

  /** Sort the rows by Δ again, as the API does (the Δ header after a live update). */
  function resort(experimentId: string): void {
    const view = records.value[experimentId]?.view;
    if (view && view.repetitions > 1) view.rows = [...view.rows].sort(byDelta);
  }

  /** The page left: no refetch is pending. The view stays for the next visit. */
  function release(experimentId: string): void {
    cancelRefresh(experimentId);
  }

  return {
    records,
    load,
    refresh,
    scheduleRefresh,
    cancelRefresh,
    applyRunEvent,
    resort,
    release,
  };
});
