/**
 * Experiments: the Experiment list and New experiment (UI_FLOWS 11 and 14.1). The experiment
 * detail page keeps its own store (experiment-detail.ts).
 *
 * Experiment list: rows are records keyed by id with the order the API gave them (newest
 * first). A refresh patches each known row in place and puts new experiments on top, so rows
 * never reorder while live; the page polls refreshList() every 5 s while anything runs (U3).
 * A failed refresh keeps the last good rows, with the time they are from.
 *
 * New experiment: what the form offers (GET /experiments/new-options), the live estimate and
 * the inline configuration diff (each answer is kept only if no newer request was made since),
 * the Duplicate draft, and the launch itself, which rejects with the ApiError for the panel
 * to show (409 reasons, 400 issues per field).
 */
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { errorMessage, isApiError, type ApiErrorKind } from '@/api/client';
import { diffConfigurations } from '@/api/configurations';
import {
  duplicateExperiment,
  estimateExperiment,
  getNewExperimentOptions,
  launchExperiment,
  listExperiments,
} from '@/api/experiments';
import type { ConfigDiff } from '@/api/types/configurations';
import type {
  EstimateQuery,
  ExperimentEstimateView,
  ExperimentListRow,
  LaunchExperimentInput,
  NewExperimentDraft,
  NewExperimentOptions,
} from '@/api/types/experiments';

/** The experiment list polls GET /experiments this often while anything runs (U3). */
export const LIST_POLL_INTERVAL_MS = 5_000;

export const useExperimentsStore = defineStore('experiments', () => {
  // ── Experiment list ──────────────────────────────────────────────────────
  const listById = ref<Record<string, ExperimentListRow>>({});
  /** Ids in the order shown: the API's newest first, new experiments added on top. */
  const listOrder = ref<string[]>([]);
  const listLoaded = ref(false);
  const listLoading = ref(false);
  /** The last load's failure, verbatim; the rows from listUpdatedAt stay. */
  const listError = ref<string | null>(null);
  /** Its kind: a network or http failure (is the api up?) or a contract mismatch (versions). */
  const listErrorKind = ref<ApiErrorKind | null>(null);
  /** When the rows shown arrived (ISO). */
  const listUpdatedAt = ref<string | null>(null);

  const listRows = computed<ExperimentListRow[]>(() =>
    listOrder.value.flatMap((id) => listById.value[id] ?? []),
  );
  /** Something is running: the list keeps polling. */
  const anyRunning = computed(() => listRows.value.some((row) => row.status === 'running'));

  /** Patch known rows in place, add new ones on top in the API's order. */
  function applyList(rows: ExperimentListRow[]): void {
    const incoming = new Set(rows.map((row) => row.id));
    const known = new Set(listOrder.value);
    const added: string[] = [];
    for (const row of rows) {
      const current = listById.value[row.id];
      if (current) Object.assign(current, row);
      else {
        listById.value[row.id] = row;
        added.push(row.id);
      }
    }
    // Experiments are never deleted; one the API no longer lists leaves the view.
    const kept = listOrder.value.filter((id) => incoming.has(id));
    for (const id of known) if (!incoming.has(id)) delete listById.value[id];
    listOrder.value = [...added, ...kept];
  }

  /** GET /experiments: the first load, a Retry, or a poll. Keeps the last rows on failure. */
  async function loadList(): Promise<void> {
    listLoading.value = true;
    try {
      applyList(await listExperiments());
      listLoaded.value = true;
      listError.value = null;
      listErrorKind.value = null;
      listUpdatedAt.value = new Date().toISOString();
    } catch (err) {
      listError.value = errorMessage(err);
      listErrorKind.value = isApiError(err) ? err.kind : null;
    } finally {
      listLoading.value = false;
    }
  }

  /** A poll: no-op while a load is in flight. */
  async function refreshList(): Promise<void> {
    if (listLoading.value) return;
    await loadList();
  }

  // ── New experiment ───────────────────────────────────────────────────────
  const options = ref<NewExperimentOptions | null>(null);
  const optionsLoading = ref(false);
  const optionsError = ref<string | null>(null);

  /** GET /experiments/new-options. Null on failure; optionsError says why. */
  async function loadOptions(): Promise<NewExperimentOptions | null> {
    optionsLoading.value = true;
    try {
      options.value = await getNewExperimentOptions();
      optionsError.value = null;
      return options.value;
    } catch (err) {
      optionsError.value = errorMessage(err);
      return null;
    } finally {
      optionsLoading.value = false;
    }
  }

  const estimate = ref<ExperimentEstimateView | null>(null);
  const estimateLoading = ref(false);
  const estimateError = ref<string | null>(null);
  let estimateSeq = 0;

  /** GET /experiments/estimate for the form as it is now; null clears it (form incomplete). */
  async function refreshEstimate(query: EstimateQuery | null): Promise<void> {
    const mine = ++estimateSeq;
    if (query === null) {
      estimate.value = null;
      estimateError.value = null;
      estimateLoading.value = false;
      return;
    }
    estimateLoading.value = true;
    try {
      const view = await estimateExperiment(query);
      if (mine !== estimateSeq) return;
      estimate.value = view;
      estimateError.value = null;
    } catch (err) {
      if (mine !== estimateSeq) return;
      estimate.value = null;
      estimateError.value = errorMessage(err);
    } finally {
      if (mine === estimateSeq) estimateLoading.value = false;
    }
  }

  const diff = ref<ConfigDiff | null>(null);
  const diffLoading = ref(false);
  const diffError = ref<string | null>(null);
  let diffSeq = 0;

  /** GET /configurations/diff for the chosen versions, baseline first; fewer than two clears it. */
  async function loadDiff(versionIds: string[]): Promise<void> {
    const mine = ++diffSeq;
    if (versionIds.length < 2) {
      diff.value = null;
      diffError.value = null;
      diffLoading.value = false;
      return;
    }
    diffLoading.value = true;
    try {
      const answer = await diffConfigurations(versionIds);
      if (mine !== diffSeq) return;
      diff.value = answer;
      diffError.value = null;
    } catch (err) {
      if (mine !== diffSeq) return;
      diff.value = null;
      diffError.value = errorMessage(err);
    } finally {
      if (mine === diffSeq) diffLoading.value = false;
    }
  }

  /** POST /experiments/:id/duplicate: the prefilled form. Rejects with the ApiError. */
  function loadDuplicate(id: string): Promise<NewExperimentDraft> {
    return duplicateExperiment(id);
  }

  const launching = ref(false);

  /**
   * POST /experiments. Resolves with the new experiment's id; rejects with the ApiError,
   * which the summary panel shows (the form keeps its values).
   */
  async function launch(input: LaunchExperimentInput): Promise<string> {
    launching.value = true;
    try {
      const { id } = await launchExperiment(input);
      return id;
    } finally {
      launching.value = false;
    }
  }

  /** Leaving the form: drop what belongs to it so the next visit starts clean. */
  function resetNewExperiment(): void {
    estimateSeq++;
    diffSeq++;
    estimate.value = null;
    estimateError.value = null;
    estimateLoading.value = false;
    diff.value = null;
    diffError.value = null;
    diffLoading.value = false;
  }

  return {
    // list
    listById,
    listOrder,
    listLoaded,
    listLoading,
    listError,
    listErrorKind,
    listUpdatedAt,
    listRows,
    anyRunning,
    applyList,
    loadList,
    refreshList,
    // new experiment
    options,
    optionsLoading,
    optionsError,
    loadOptions,
    estimate,
    estimateLoading,
    estimateError,
    refreshEstimate,
    diff,
    diffLoading,
    diffError,
    loadDiff,
    loadDuplicate,
    launching,
    launch,
    resetNewExperiment,
  };
});
