/**
 * The run inspector's data (plan 12.3, U3, U4): run details keyed by id, the timeline cursor
 * of each, the order the opening page lists its runs in (Prev / Next, J / K), the A/B jump,
 * and the single-run actions.
 *
 * Live runs: the drawer polls refreshEvents() every second while the timeline is live, and
 * load() every few seconds while the run is unsettled. Event pages patch the record in
 * place (rows replaced by seq, new ones appended), so nothing reorders. The cursor is the
 * shown attempt's: when GET /runs/:id reports a new shownAttempt (a retry started), it goes
 * back to 0 and the timeline is the new attempt's.
 *
 * The opening page says how its runs are ordered with setOrder(); a page that opened the
 * drawer without one (a pasted link) gets the experiment's runs in their default order.
 */
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { errorMessage } from '@/api/client';
import { cancelRun, getRun, listRunEvents, listRuns, rescoreRun, retryRun } from '@/api/runs';
import type {
  RescoreRunResult,
  RunActionResult,
  RunDetail,
  RunEventsPage,
  TimelineEvent,
} from '@/api/types/runs';

/** How the opening page lists its runs. */
export interface RunOrder {
  experimentId: string;
  /** The page, as the drawer header names it: "Comparison", "Runs", "Overview". */
  source: string;
  /** How that page orders them: "grid order", "filtered order", "live feed". */
  order: string;
  /** Run ids in that order: Prev and Next (K and J) step through them. */
  ids: string[];
  /** Shown instead of "run 15 of 120" where a position means nothing: "opened from the feed". */
  note?: string | null;
  /** Built by the drawer itself (the page set none): the experiment's runs, default order. */
  fallback?: boolean;
}

/** The A/B jump just taken: the header then reads "Comparison · A/B jump from run 15 (baseline)". */
export interface RunJump {
  from: string;
  to: string;
  /** The configuration of the run jumped from. */
  configuration: string;
}

/** The two lines of the header's "Run position" nav. */
export interface RunPosition {
  label: string;
  run: string;
}

/** A page of the events endpoint holds at most this many rows; a full page asks again. */
const EVENTS_PAGE_LIMIT = 2000;
/** At most this many pages back to back in one refresh; the next poll goes on. */
const MAX_PAGES_PER_REFRESH = 5;

const STATUSES_SETTLED = new Set<RunDetail['status']>(['scored', 'execution_error', 'cancelled']);

/** The run will still change by itself: not finished, or a re-score is in flight. */
export function isUnsettled(detail: RunDetail): boolean {
  return !STATUSES_SETTLED.has(detail.status) || detail.evaluation.pending !== null;
}

/** Rows replaced by seq and new ones appended, in seq order. */
export function mergeEvents(
  current: readonly TimelineEvent[],
  incoming: readonly TimelineEvent[],
): TimelineEvent[] {
  if (!incoming.length) return [...current];
  const bySeq = new Map(current.map((e) => [e.seq, e] as const));
  for (const event of incoming) bySeq.set(event.seq, event);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

const maxSeq = (events: readonly TimelineEvent[]): number =>
  events.reduce((max, e) => Math.max(max, e.seq), 0);

export const useInspectorStore = defineStore('inspector', () => {
  /** Run details keyed by id. */
  const runs = ref<Record<string, RunDetail>>({});
  /** When each detail arrived (epoch ms): the live header's elapsed time counts on from it. */
  const loadedAt = ref<Record<string, number>>({});
  /** A first load is in flight (no detail to show yet). */
  const loading = ref<Record<string, boolean>>({});
  /** The last load's failure, quoted by the drawer's ErrorBanner. */
  const errors = ref<Record<string, string | null>>({});
  const order = ref<RunOrder | null>(null);
  const jump = ref<RunJump | null>(null);
  /** The events cursor per run: the attempt it belongs to and the last seq read. */
  const cursors: Record<string, { attempt: number; after: number }> = {};
  let fallbackFor: string | null = null;

  function apply(detail: RunDetail): void {
    let cursor = cursors[detail.id];
    if (!cursor || cursor.attempt !== detail.shownAttempt) {
      // A new attempt numbers its events from 1 again: start over.
      cursor = { attempt: detail.shownAttempt, after: 0 };
      cursors[detail.id] = cursor;
    }
    // The detail's timeline holds every row so far; poll on from its last one.
    cursor.after = Math.max(cursor.after, maxSeq(detail.timeline.events));
    runs.value[detail.id] = detail;
    loadedAt.value[detail.id] = Date.now();
  }

  /** GET /runs/:id. `quiet` refreshes without the loading state (polls, after an action). */
  async function load(runId: string, options: { quiet?: boolean } = {}): Promise<void> {
    if (!options.quiet) loading.value[runId] = true;
    try {
      apply(await getRun(runId));
      errors.value[runId] = null;
    } catch (err) {
      errors.value[runId] = errorMessage(err);
    } finally {
      loading.value[runId] = false;
    }
  }

  function applyPage(runId: string, attempt: number, page: RunEventsPage): boolean {
    const detail = runs.value[runId];
    const cursor = cursors[runId];
    // The run moved to another attempt meanwhile: this page is about the old one.
    if (!detail || !cursor || detail.shownAttempt !== attempt || cursor.attempt !== attempt) {
      return false;
    }
    const events = mergeEvents(detail.timeline.events, page.events);
    detail.timeline.events = events;
    detail.timeline.totalEvents = Math.max(detail.timeline.totalEvents, events.length);
    cursor.after = Math.max(cursor.after, page.lastSeq);
    return true;
  }

  /**
   * GET /runs/:id/events?after=: the rows touched since the last call, patched in place.
   * When the page says the run is no longer live, the detail is reloaded for its outcome.
   */
  async function refreshEvents(runId: string): Promise<void> {
    const detail = runs.value[runId];
    const cursor = cursors[runId];
    if (!detail || !cursor) return;
    const attempt = detail.shownAttempt;
    let page: RunEventsPage | null = null;
    for (let i = 0; i < MAX_PAGES_PER_REFRESH; i++) {
      const before = cursor.after;
      page = await listRunEvents(runId, before);
      if (!applyPage(runId, attempt, page)) return;
      if (page.events.length < EVENTS_PAGE_LIMIT || cursor.after <= before) break;
    }
    const current = runs.value[runId];
    if (page && current && current.timeline.live && !page.live) {
      current.timeline.live = false;
      await load(runId, { quiet: true });
    }
  }

  /** The opening page's order of runs (or null to forget it). */
  function setOrder(next: RunOrder | null): void {
    order.value = next;
    if (next && !next.fallback) fallbackFor = null;
  }

  /**
   * Without an order from the page (a pasted link), step through the experiment's runs in
   * their default order (GET /experiments/:id/runs). A failure leaves Prev and Next off.
   */
  async function ensureOrder(experimentId: string, source: string): Promise<void> {
    if (order.value?.experimentId === experimentId || fallbackFor === experimentId) return;
    fallbackFor = experimentId;
    try {
      const result = await listRuns(experimentId);
      if (order.value?.experimentId === experimentId) return;
      order.value = {
        experimentId,
        source,
        order: 'all runs',
        ids: result.rows.map((r) => r.id),
        fallback: true,
      };
    } catch {
      fallbackFor = null;
    }
  }

  function indexOf(runId: string): number {
    const ids = order.value?.ids ?? [];
    const at = ids.indexOf(runId);
    if (at >= 0) return at;
    // Jumped to the counterpart: step on from the run the jump started at.
    return jump.value?.to === runId ? ids.indexOf(jump.value.from) : -1;
  }

  /** Prev and Next from a run, in the opening page's order. */
  function neighbours(runId: string): { prev: string | null; next: string | null } {
    const ids = order.value?.ids ?? [];
    const at = indexOf(runId);
    if (at < 0) return { prev: null, next: null };
    return { prev: ids[at - 1] ?? null, next: ids[at + 1] ?? null };
  }

  /** The header's position line: "Comparison · grid order" · "run 15 of 120". */
  function positionOf(runId: string): RunPosition | null {
    const o = order.value;
    if (!o) return null;
    const ids = o.ids;
    if (jump.value?.to === runId) {
      const from = ids.indexOf(jump.value.from);
      const run =
        from >= 0
          ? `run ${from + 1} (${jump.value.configuration})`
          : `the ${jump.value.configuration} run`;
      return { label: `${o.source} · A/B jump from`, run };
    }
    const at = ids.indexOf(runId);
    if (at < 0) return null;
    return {
      label: `${o.source} · ${o.order}`,
      run: o.note ?? `run ${at + 1} of ${ids.length}`,
    };
  }

  /** Prev, Next or another way out of an A/B jump: the header reads the list position again. */
  function clearJump(): void {
    jump.value = null;
  }

  /** Remember the A/B jump about to be taken, for the header and for Prev / Next. */
  function recordJump(from: string, to: string, configuration: string): void {
    // Jumping back to where the jump started is just that run again.
    jump.value =
      jump.value?.to === from && jump.value.from === to ? null : { from, to, configuration };
  }

  /** POST /runs/:id/rescore, then the detail again (it shows the pending re-score). */
  async function rescore(runId: string): Promise<RescoreRunResult> {
    const result = await rescoreRun(runId);
    await load(runId, { quiet: true });
    return result;
  }

  /** POST /runs/:id/retry: the run is queued for its next attempt. */
  async function retry(runId: string): Promise<RunActionResult> {
    const result = await retryRun(runId);
    await load(runId, { quiet: true });
    return result;
  }

  /** POST /runs/:id/cancel: a queued run stops at once, a running one when the worker stops it. */
  async function cancel(runId: string): Promise<RunActionResult> {
    const result = await cancelRun(runId);
    await load(runId, { quiet: true });
    return result;
  }

  return {
    runs,
    loadedAt,
    loading,
    errors,
    order,
    jump,
    load,
    refreshEvents,
    setOrder,
    ensureOrder,
    neighbours,
    positionOf,
    recordJump,
    clearJump,
    rescore,
    retry,
    cancel,
  };
});
