/**
 * Suite drafts (plan 4.6; SA.1 to SA.3, SA.11, SA.12): each open draft by folder, the list
 * of open drafts for the suite list, and the writes a draft takes as a whole. Files stay the
 * source of truth: nothing here touches ./suites; the API stores the draft, and Save writes
 * the folder through the worker.
 *
 * Edit details saves itself: each change is sent after a short pause (DETAILS_DEBOUNCE_MS),
 * one write at a time, and the bar reads "saving…" until it is stored, then "saved 16:31"
 * from the draft's own time. A failed write keeps the edit and says so, with Try again. The
 * task editor's autosave is in ./draftTask.ts.
 */
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { errorMessage, isApiError } from '@/api/client';
import {
  createDraftTask,
  createSuiteDraft,
  discardSuiteDraft,
  getDraftReview,
  getSuiteDraft,
  listDrafts,
  openSuiteDraft,
  rebaseSuiteDraft,
  removeDraftTask,
  saveSuiteDraft,
  updateDraftTask,
  updateSuiteDraft,
  type DraftRebaseOutcome,
  type DraftSaveOutcome,
} from '@/api/drafts';
import type {
  CreateDraftTaskRequest,
  CreateSuiteDraftRequest,
  DraftReview,
  DraftSummary,
  DraftTaskCreateResult,
  RebaseSuiteDraftRequest,
  SaveSuiteDraftRequest,
  SuiteDraftView,
  UpdateSuiteDraftRequest,
} from '@/api/types/authoring';

/** Pause after the last keystroke in Edit details before the draft is written. */
export const DETAILS_DEBOUNCE_MS = 500;

export interface DraftWriteState {
  /** A write is waiting for its pause or on its way. */
  saving: boolean;
  /** The last write failed, verbatim; the edit is kept and Try again sends it. */
  error: string | null;
}

type DetailsPatch = Pick<UpdateSuiteDraftRequest, 'versionLabel' | 'description'>;

export const useDraftStore = defineStore('draft', () => {
  const drafts = ref<Record<string, SuiteDraftView>>({});
  /** Folders whose draft the API answered 404 for: there is none. */
  const missing = ref<Record<string, true>>({});
  const summaries = ref<DraftSummary[]>([]);
  const summariesLoaded = ref(false);
  const summariesError = ref<string | null>(null);
  const writes = ref<Record<string, DraftWriteState>>({});

  const pendingDetails = new Map<string, DetailsPatch>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const inFlight = new Map<string, Promise<void>>();

  function apply(view: SuiteDraftView): SuiteDraftView {
    drafts.value[view.folder] = view;
    delete missing.value[view.folder];
    return view;
  }

  /** The reactive write state of a folder (created on first use). */
  function writeState(folder: string): DraftWriteState {
    if (!writes.value[folder]) writes.value[folder] = { saving: false, error: null };
    return writes.value[folder]!;
  }

  async function loadSummaries(): Promise<void> {
    try {
      summaries.value = await listDrafts();
      summariesError.value = null;
      summariesLoaded.value = true;
    } catch (err) {
      summariesError.value = errorMessage(err);
    }
  }

  /** The draft of a folder, fetched again; null when the folder has none (404). */
  async function load(folder: string): Promise<SuiteDraftView | null> {
    try {
      return apply(await getSuiteDraft(folder));
    } catch (err) {
      if (isApiError(err) && err.status === 404) {
        delete drafts.value[folder];
        missing.value[folder] = true;
        return null;
      }
      throw err;
    }
  }

  /** Starts a draft of a folder on its current version, or opens the one already there. */
  async function open(folder: string): Promise<SuiteDraftView> {
    return apply(await openSuiteDraft(folder));
  }

  async function create(body: CreateSuiteDraftRequest): Promise<SuiteDraftView> {
    return apply(await createSuiteDraft(body));
  }

  /** Edit details: shown at once, written after a pause. */
  function editDetails(folder: string, patch: DetailsPatch): void {
    const view = drafts.value[folder];
    if (view) drafts.value[folder] = { ...view, ...patch } as SuiteDraftView;
    pendingDetails.set(folder, { ...pendingDetails.get(folder), ...patch });
    writeState(folder).saving = true;
    const timer = timers.get(folder);
    if (timer) clearTimeout(timer);
    timers.set(
      folder,
      setTimeout(() => void flushDetails(folder), DETAILS_DEBOUNCE_MS),
    );
  }

  /** Sends what Edit details holds now (Done, leaving the page, Try again). */
  async function flushDetails(folder: string): Promise<void> {
    const timer = timers.get(folder);
    if (timer) clearTimeout(timer);
    timers.delete(folder);
    const running = inFlight.get(folder);
    if (running) {
      await running;
      if (!pendingDetails.has(folder)) return;
    }
    const patch = pendingDetails.get(folder);
    if (!patch) return;
    pendingDetails.delete(folder);
    const state = writeState(folder);
    const write = (async () => {
      try {
        const view = await updateSuiteDraft(folder, patch);
        // Keep what was typed while the write was on its way.
        apply({ ...view, ...pendingDetails.get(folder) } as SuiteDraftView);
        state.error = null;
      } catch (err) {
        pendingDetails.set(folder, { ...patch, ...pendingDetails.get(folder) });
        state.error = errorMessage(err);
      }
    })();
    inFlight.set(folder, write);
    await write;
    inFlight.delete(folder);
    state.saving = pendingDetails.has(folder) && state.error === null;
    if (state.saving) await flushDetails(folder);
  }

  /** The task order (drag in the draft's task table), every key included. */
  async function reorder(folder: string, order: string[]): Promise<void> {
    const view = drafts.value[folder];
    if (view) {
      const byKey = new Map(view.tasks.map((t) => [t.key, t]));
      const tasks = order.flatMap((k, i) =>
        byKey.has(k) ? [{ ...byKey.get(k)!, position: i }] : [],
      );
      drafts.value[folder] = { ...view, tasks };
    }
    const state = writeState(folder);
    state.saving = true;
    try {
      apply(await updateSuiteDraft(folder, { order }));
      state.error = null;
    } catch (err) {
      state.error = errorMessage(err);
      await load(folder).catch(() => undefined);
    } finally {
      state.saving = false;
    }
  }

  /** Discard: the draft goes, nothing on disk changes. */
  async function discard(folder: string): Promise<void> {
    await discardSuiteDraft(folder);
    delete drafts.value[folder];
    missing.value[folder] = true;
    summaries.value = summaries.value.filter((s) => s.folder !== folder);
  }

  async function addTask(
    folder: string,
    body: CreateDraftTaskRequest,
  ): Promise<DraftTaskCreateResult> {
    const result = await createDraftTask(folder, body);
    apply(result.draft);
    return result;
  }

  /** Remove from suite: a base task is struck through with Undo, an added one goes. */
  async function removeTask(folder: string, key: string): Promise<SuiteDraftView> {
    return apply(await removeDraftTask(folder, key));
  }

  /** Undo a removal: the task comes back as it was. */
  async function undoRemove(folder: string, key: string): Promise<void> {
    await updateDraftTask(folder, key, { removed: false });
    await load(folder);
  }

  /** Restore this version into the draft (Task detail on an older task version, SA.3). */
  async function restoreTask(
    folder: string,
    suiteVersion: number,
    key: string,
  ): Promise<DraftTaskCreateResult> {
    const result = await createDraftTask(folder, { kind: 'restore', suiteVersion, key });
    apply(result.draft);
    return result;
  }

  async function review(folder: string): Promise<DraftReview> {
    await flushDetails(folder);
    const result = await getDraftReview(folder);
    apply(result.draft);
    return result;
  }

  /** Save as the next version: the draft is gone once it is saved; a conflict is kept on it. */
  async function save(folder: string, body: SaveSuiteDraftRequest): Promise<DraftSaveOutcome> {
    await flushDetails(folder);
    const outcome = await saveSuiteDraft(folder, body);
    if (outcome.kind === 'saved') {
      delete drafts.value[folder];
      missing.value[folder] = true;
      summaries.value = summaries.value.filter((s) => s.folder !== folder);
    } else if (outcome.kind === 'conflict') {
      const view = drafts.value[folder];
      if (view) drafts.value[folder] = { ...view, conflict: outcome.body.conflict };
    }
    return outcome;
  }

  /** Combine onto the newer version, keeping one side of each overlapping task. */
  async function rebase(
    folder: string,
    body: RebaseSuiteDraftRequest,
  ): Promise<DraftRebaseOutcome> {
    const outcome = await rebaseSuiteDraft(folder, body);
    if (outcome.kind === 'rebased') apply(outcome.draft);
    else {
      const view = drafts.value[folder];
      if (view) drafts.value[folder] = { ...view, conflict: outcome.body.conflict };
    }
    return outcome;
  }

  return {
    drafts,
    missing,
    summaries,
    summariesLoaded,
    summariesError,
    writes,
    apply,
    writeState,
    loadSummaries,
    load,
    open,
    create,
    editDetails,
    flushDetails,
    reorder,
    discard,
    addTask,
    removeTask,
    undoRemove,
    restoreTask,
    review,
    save,
    rebase,
  };
});
