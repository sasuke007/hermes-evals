/**
 * Suite authoring around the editor (Phase 5b, plan 4.6): the open drafts the suite list
 * marks with a chip, starting a draft from Suite detail or Task detail, a new suite, the zip
 * and CSV imports, and Review and save with its progress and outcomes. The draft itself and
 * its tasks are the editor's; this store only starts, reviews, saves and combines drafts.
 *
 * A save, a combine or an import changes what the suite list and the details show, so each
 * refreshes the open drafts, and a saved draft invalidates the suites store.
 */
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { errorMessage } from '@/api/client';
import {
  addDraftTask,
  createSuiteDraft,
  getDraftReview,
  getDraftTaskDiff,
  getSaveProgress,
  getSuiteDraft,
  importSuiteZip,
  importTasks,
  listSuiteDrafts,
  rebaseSuiteDraft,
  removeDraftTask,
  saveSuiteDraft,
  startSuiteDraft,
  validateSuiteZip,
  validateTaskImport,
  type DraftSaveOutcome,
  type RebaseOutcome,
  type TaskImportOutcome,
} from '@/api/suites-authoring';
import type {
  CreateDraftTaskRequest,
  CreateSuiteDraftRequest,
  DraftReview,
  DraftSaveProgress,
  DraftSummary,
  DraftTaskCreateResult,
  DraftTaskDiff,
  RebaseSuiteDraftRequest,
  SaveSuiteDraftRequest,
  SuiteDraftView,
  SuiteZipImportRequest,
  SuiteZipValidation,
  TaskImportSettings,
  TaskImportValidation,
} from '@/api/types/authoring';
import { useSuitesStore } from './suites';

/** How often a running save's step is read. */
export const SAVE_PROGRESS_POLL_MS = 1000;

export const useSuiteAuthoringStore = defineStore('suites-authoring', () => {
  const suites = useSuitesStore();

  const drafts = ref<DraftSummary[]>([]);
  const draftsLoaded = ref(false);
  /** The chips are extra: a failed read leaves the list as it is and keeps the message. */
  const draftsError = ref<string | null>(null);

  /**
   * The step of the save in flight, from GET /suites/:suite/draft; after it ends, the last
   * step read (for "Self-checks 2 of 2"), until the next save starts.
   */
  const saveProgress = ref<DraftSaveProgress | null>(null);

  async function loadDrafts(): Promise<void> {
    try {
      drafts.value = await listSuiteDrafts();
      draftsError.value = null;
      draftsLoaded.value = true;
    } catch (err) {
      draftsError.value = errorMessage(err);
    }
  }

  /** The open draft of a folder (`folder` is the suite's folder name), if any. */
  function draftOf(folder: string): DraftSummary | null {
    return drafts.value.find((d) => d.folder === folder) ?? null;
  }

  /** Open drafts of suites never saved: the list shows them as rows of their own. */
  function newSuiteDrafts(): DraftSummary[] {
    return drafts.value.filter((d) => d.baseVersion === null);
  }

  async function createSuite(request: CreateSuiteDraftRequest): Promise<SuiteDraftView> {
    const view = await createSuiteDraft(request);
    void loadDrafts();
    return view;
  }

  /** The folder's draft: the one already open, or a new one on the current version. */
  async function startDraft(folder: string): Promise<SuiteDraftView> {
    const view = await startSuiteDraft(folder);
    void loadDrafts();
    return view;
  }

  /** Starts the folder's draft if needed, then adds a task to it (Add task, Duplicate, Restore). */
  async function addTask(
    folder: string,
    request: CreateDraftTaskRequest,
  ): Promise<DraftTaskCreateResult> {
    await startSuiteDraft(folder);
    const result = await addDraftTask(folder, request);
    void loadDrafts();
    return result;
  }

  /** Starts the folder's draft if needed, then marks a task removed (Remove from suite). */
  async function removeTask(folder: string, key: string): Promise<SuiteDraftView> {
    await startSuiteDraft(folder);
    const view = await removeDraftTask(folder, key);
    void loadDrafts();
    return view;
  }

  function loadReview(folder: string): Promise<DraftReview> {
    return getDraftReview(folder);
  }

  function loadDraft(folder: string): Promise<SuiteDraftView> {
    return getSuiteDraft(folder);
  }

  function loadTaskDiff(folder: string, key: string): Promise<DraftTaskDiff> {
    return getDraftTaskDiff(folder, key);
  }

  /**
   * Save as the next version. The step is polled while the worker runs it; a conflict the
   * answer did not carry is read from the draft. A saved draft is gone, so the drafts and
   * what the suites store holds are refreshed.
   */
  async function save(folder: string, request: SaveSuiteDraftRequest): Promise<DraftSaveOutcome> {
    saveProgress.value = null;
    const stop = pollSaveProgress(folder);
    let outcome: DraftSaveOutcome;
    try {
      outcome = await saveSuiteDraft(folder, request);
    } finally {
      stop();
    }
    if (outcome.kind === 'conflict' && outcome.conflict === null) {
      const view = await getSuiteDraft(folder).catch(() => null);
      outcome = { ...outcome, conflict: view?.conflict ?? null };
    }
    if (outcome.kind === 'saved') await suites.invalidate();
    void loadDrafts();
    return outcome;
  }

  function pollSaveProgress(folder: string): () => void {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async (): Promise<void> => {
      try {
        const progress = await getSaveProgress(folder);
        if (!stopped && progress) saveProgress.value = progress;
      } catch {
        /* the save's own answer says how it went; a missed read only delays the steps */
      }
      if (!stopped) timer = setTimeout(() => void tick(), SAVE_PROGRESS_POLL_MS);
    };
    timer = setTimeout(() => void tick(), SAVE_PROGRESS_POLL_MS / 4);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }

  /** Combine onto the newer version on disk, with a side kept for each overlapping task. */
  async function rebase(folder: string, request: RebaseSuiteDraftRequest): Promise<RebaseOutcome> {
    const outcome = await rebaseSuiteDraft(folder, request);
    void loadDrafts();
    return outcome;
  }

  function validateZip(file: File): Promise<SuiteZipValidation> {
    return validateSuiteZip(file);
  }

  async function importZip(request: SuiteZipImportRequest): Promise<SuiteDraftView> {
    const view = await importSuiteZip(request);
    void loadDrafts();
    return view;
  }

  function validateTasks(
    folder: string,
    file: File,
    settings: TaskImportSettings | null,
    workspace: readonly File[] = [],
    takenKeys: readonly string[] = [],
  ): Promise<TaskImportValidation> {
    return validateTaskImport(folder, file, settings, workspace, takenKeys);
  }

  async function addImportedTasks(
    folder: string,
    file: File,
    settings: TaskImportSettings,
    workspace: readonly File[] = [],
    takenKeys: readonly string[] = [],
  ): Promise<TaskImportOutcome> {
    const outcome = await importTasks(folder, file, settings, workspace, takenKeys);
    void loadDrafts();
    return outcome;
  }

  return {
    drafts,
    draftsLoaded,
    draftsError,
    saveProgress,
    loadDrafts,
    draftOf,
    newSuiteDrafts,
    createSuite,
    startDraft,
    addTask,
    removeTask,
    loadReview,
    loadDraft,
    loadTaskDiff,
    save,
    rebase,
    validateZip,
    importZip,
    validateTasks,
    addImportedTasks,
  };
});
