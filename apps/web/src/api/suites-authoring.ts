/**
 * Suite authoring around the editor (plan 4.6 and 11, Phase 5b): the open
 * drafts, a new suite, a draft of an existing folder, adding or removing a
 * task from Suite detail, the review, the save and its outcomes, Combine
 * onto a newer version, and the CSV, JSONL and zip imports. The task editor's
 * own calls live with the editor.
 *
 * Draft routes address a suite by its folder name. The calls a draft shares
 * with the editor go through the editor's data layer (./drafts.ts), so live
 * and fixtures mode see one draft world; this module adds what Review and
 * save draws (the outcomes, 503 included, and the step while the worker
 * saves) and the imports. Live mode parses every answer with its shared
 * schema; fixtures mode serves src/fixtures/suites-import.ts, the editor's
 * draft world, and the save states of src/fixtures/suites-authoring.ts.
 */
import {
  DraftSaveProgressSchema,
  SuiteDraftViewSchema,
  SuiteZipValidationSchema,
  TaskImportRefusalBodySchema,
  TaskImportResultSchema,
  TaskImportValidationSchema,
} from '@hermes-evals/shared';
import type { ZodType } from 'zod';
import type {
  CreateDraftTaskRequest,
  CreateSuiteDraftRequest,
  DraftConflict,
  DraftReview,
  DraftSaveProgress,
  DraftSaveResult,
  DraftSummary,
  DraftTaskCreateResult,
  DraftTaskDiff,
  RebaseSuiteDraftRequest,
  SaveStep,
  SaveSuiteDraftRequest,
  SuiteDraftView,
  SuiteZipImportRequest,
  SuiteZipValidation,
  TaskImportPreview,
  TaskImportResult,
  TaskImportSettings,
  TaskImportValidation,
} from './types/authoring';
import type { SuiteLoadErrorView } from './types/suites';
import { apiGet, apiSend, isApiError } from './client';
import * as drafts from './drafts';
import { apiMode, fixture, hasScenario } from './source';
import { SAVE_FAILURE, draftStateFrom } from '@/fixtures/suites-authoring';
import { suiteZipValidationFixture, taskImportValidationFixture } from '@/fixtures/suites-import';

const seg = (value: string): string => encodeURIComponent(value);
const draftPath = (folder: string): string => `/suites/${seg(folder)}/draft`;

/** The save states of Review and save that the editor's draft fixtures do not draw. */
const saveScenarios = () => draftStateFrom(hasScenario);

/** The error body of a refused call (ApiError.body), parsed with `schema`; null otherwise. */
function bodyOf<T>(err: unknown, schema: ZodType<T>): T | null {
  if (!isApiError(err)) return null;
  const parsed = schema.safeParse(err.body);
  return parsed.success ? parsed.data : null;
}

// ---------------------------------------------------------------------------
// Drafts: the editor's data layer (./drafts.ts), so both share one draft world
// ---------------------------------------------------------------------------

/** GET /suites/drafts: every open draft, for the suite list's chips. */
export const listSuiteDrafts = (): Promise<DraftSummary[]> => drafts.listDrafts();

/** POST /suites/drafts: a new suite as a draft (SA.2); 409 when the name is held. */
export const createSuiteDraft = (request: CreateSuiteDraftRequest): Promise<SuiteDraftView> =>
  drafts.createSuiteDraft(request);

/**
 * POST /suites/:suite/draft: the folder's draft, opened on its current
 * version, or the one already open. Every authoring action on Suite detail
 * and Task detail starts here.
 */
export const startSuiteDraft = (folder: string): Promise<SuiteDraftView> =>
  drafts.openSuiteDraft(folder);

/** GET /suites/:suite/draft: the draft with its save progress and any conflict; 404 without one. */
export const getSuiteDraft = (folder: string): Promise<SuiteDraftView> =>
  drafts.getSuiteDraft(folder);

/** POST /suites/:suite/draft/tasks: a blank, duplicated or restored task, or tasks copied in. */
export const addDraftTask = (
  folder: string,
  request: CreateDraftTaskRequest,
): Promise<DraftTaskCreateResult> => drafts.createDraftTask(folder, request);

/** DELETE /suites/:suite/draft/tasks/:key: a base task marked removed, an added one dropped. */
export const removeDraftTask = (folder: string, key: string): Promise<SuiteDraftView> =>
  drafts.removeDraftTask(folder, key);

/** GET …/draft/tasks/:key/diff: the draft task against its base version. */
export const getDraftTaskDiff = (folder: string, key: string): Promise<DraftTaskDiff> =>
  drafts.getDraftTaskDiff(folder, key);

// ---------------------------------------------------------------------------
// Review, save, rebase (SA.11, SA.12)
// ---------------------------------------------------------------------------

/**
 * GET /suites/:suite/draft/review: what Save writes and creates. In fixtures
 * mode `draft-invalid-task` marks the added task invalid (the confirm step)
 * and `draft-no-changes` empties the draft (Nothing changed).
 */
export async function getDraftReview(folder: string): Promise<DraftReview> {
  const review = await drafts.getDraftReview(folder);
  if (apiMode === 'live') return review;
  const state = saveScenarios();
  if (state.noChanges) {
    return {
      draft: { ...review.draft, changes: [] },
      changes: [],
      writes: [],
      readiness: [],
      invalid: [],
    };
  }
  if (state.invalidTask && review.readiness.length > 0) {
    const first = review.readiness[0]!;
    return {
      ...review,
      readiness: review.readiness.map((r, i) =>
        i === 0 ? { ...r, readiness: 'problems', note: `${r.state} · self-check failed` } : r,
      ),
      invalid: [{ key: first.key, reason: 'self-check failed' }],
    };
  }
  return review;
}

/** How a save ended, as the right panel of Review and save draws it. */
export type DraftSaveOutcome =
  | { kind: 'saved'; result: DraftSaveResult }
  /** 409: the folder moved past the base; `conflict` when the body carried it. */
  | { kind: 'conflict'; conflict: DraftConflict | null; message: string }
  /** 422: the staging folder failed the loader; nothing on disk changed. */
  | { kind: 'failed'; step: SaveStep; message: string; error: SuiteLoadErrorView | null }
  /** 503: no live worker. */
  | { kind: 'no-worker'; message: string };

/** When the fixture save began, so the progress poll can walk the steps. */
let fixtureSaveStarted: number | null = null;

function savingFixture(): DraftSaveProgress | null {
  if (fixtureSaveStarted === null) return null;
  const elapsed = Date.now() - fixtureSaveStarted;
  const step: SaveStep =
    elapsed < 400
      ? 'staging'
      : elapsed < 800
        ? 'loading'
        : elapsed < 1400
          ? 'self_checks'
          : 'moving';
  return {
    startedAt: new Date(fixtureSaveStarted).toISOString(),
    step,
    selfChecks:
      step === 'self_checks' || step === 'moving'
        ? { done: elapsed < 1100 ? 1 : 2, total: 2 }
        : null,
  };
}

/**
 * POST /suites/:suite/draft/save. The answer comes when the worker is done;
 * GET /suites/:suite/draft reports the step meanwhile. Refusals the page
 * draws (409, 422, 503) resolve as outcomes; anything else rejects.
 */
export async function saveSuiteDraft(
  folder: string,
  request: SaveSuiteDraftRequest,
): Promise<DraftSaveOutcome> {
  const state = saveScenarios();
  if (apiMode === 'fixtures') fixtureSaveStarted = Date.now();
  try {
    if (apiMode === 'fixtures' && state.saveFailed) {
      await fixture(null, { request: `POST /api${draftPath(folder)}/save`, latencyMs: 900 });
      return {
        kind: 'failed',
        step: SAVE_FAILURE.step,
        message: SAVE_FAILURE.message,
        error: SAVE_FAILURE.error,
      };
    }
    if (apiMode === 'fixtures' && state.noChanges) {
      const view = await drafts.getSuiteDraft(folder);
      if (view.base) {
        return {
          kind: 'saved',
          result: {
            outcome: 'unchanged',
            suite: view.base,
            changes: { added: [], removed: [], changed: [], nowInvalid: [], nowValid: [] },
            taskCount: view.tasks.length,
            validCount: view.tasks.filter((t) => t.readiness !== 'problems').length,
            invalid: [],
          },
        };
      }
    }
    const outcome = await drafts.saveSuiteDraft(folder, request);
    if (outcome.kind === 'saved') return { kind: 'saved', result: outcome.result };
    if (outcome.kind === 'conflict') {
      return { kind: 'conflict', conflict: outcome.body.conflict, message: outcome.body.message };
    }
    return {
      kind: 'failed',
      step: outcome.body.step,
      message: outcome.body.message,
      error: outcome.body.error,
    };
  } catch (err) {
    if (isApiError(err) && err.status === 503) return { kind: 'no-worker', message: err.detail };
    throw err;
  } finally {
    fixtureSaveStarted = null;
  }
}

/** The save step a draft reports while its save runs. */
export async function getSaveProgress(folder: string): Promise<DraftSaveProgress | null> {
  if (apiMode === 'live') {
    const view = await apiGet(draftPath(folder), SuiteDraftViewSchema);
    return view.saving === null ? null : DraftSaveProgressSchema.parse(view.saving);
  }
  return savingFixture();
}

/** How Combine ended: the draft based on the newer version, or a new conflict (409). */
export type RebaseOutcome =
  | { kind: 'combined'; draft: SuiteDraftView }
  | { kind: 'conflict'; conflict: DraftConflict; message: string };

/** POST /suites/:suite/draft/rebase: combine onto `onto`, keeping one side of each overlap. */
export async function rebaseSuiteDraft(
  folder: string,
  request: RebaseSuiteDraftRequest,
): Promise<RebaseOutcome> {
  const outcome = await drafts.rebaseSuiteDraft(folder, request);
  return outcome.kind === 'rebased'
    ? { kind: 'combined', draft: outcome.draft }
    : { kind: 'conflict', conflict: outcome.body.conflict, message: outcome.body.message };
}

// ---------------------------------------------------------------------------
// Imports (SA.9, SA.10)
// ---------------------------------------------------------------------------

function importBody(
  file: File,
  settings: TaskImportSettings | null,
  workspace: readonly File[],
): FormData {
  const body = new FormData();
  body.append('file', file);
  if (settings) body.append('settings', JSON.stringify(settings));
  for (const f of workspace) body.append('workspace', f);
  return body;
}

/**
 * POST /suites/:suite/draft/import/validate: the file as read, its refusal,
 * or with settings the preview. `takenKeys` (the draft's keys) only serve the
 * fixtures; the API knows them.
 */
export function validateTaskImport(
  folder: string,
  file: File,
  settings: TaskImportSettings | null,
  workspace: readonly File[] = [],
  takenKeys: readonly string[] = [],
): Promise<TaskImportValidation> {
  const path = `${draftPath(folder)}/import/validate`;
  if (apiMode === 'live') {
    return apiSend('POST', path, importBody(file, settings, workspace), TaskImportValidationSchema);
  }
  return fixture(() => taskImportValidationFixture(file.name, file.size, settings, takenKeys), {
    request: `POST /api${path}`,
    latencyMs: 400,
  });
}

/** How Add ended: the tasks added, or rows that still need a fix (422 with the preview). */
export type TaskImportOutcome =
  | { kind: 'added'; result: TaskImportResult }
  | { kind: 'refused'; preview: TaskImportPreview | null; message: string };

/** POST /suites/:suite/draft/import: the rows become added tasks of the draft. */
export async function importTasks(
  folder: string,
  file: File,
  settings: TaskImportSettings,
  workspace: readonly File[] = [],
  takenKeys: readonly string[] = [],
): Promise<TaskImportOutcome> {
  const path = `${draftPath(folder)}/import`;
  if (apiMode === 'fixtures') {
    const validation = await validateTaskImport(folder, file, settings, workspace, takenKeys);
    const preview = validation.preview;
    if (!preview || preview.fixCount > 0) {
      return { kind: 'refused', preview, message: 'A row needs a fix.' };
    }
    // The rows become tasks of the editor's draft world, so the draft page lists them.
    let draft = await drafts.openSuiteDraft(folder);
    for (const row of preview.rows) {
      draft = (await drafts.createDraftTask(folder, { kind: 'blank', key: row.key })).draft;
    }
    return { kind: 'added', result: { added: preview.rows.map((r) => r.key), draft } };
  }
  try {
    const result = await apiSend(
      'POST',
      path,
      importBody(file, settings, workspace),
      TaskImportResultSchema,
    );
    return { kind: 'added', result };
  } catch (err) {
    if (isApiError(err) && err.status === 422) {
      return {
        kind: 'refused',
        preview: bodyOf(err, TaskImportRefusalBodySchema)?.preview ?? null,
        message: err.detail,
      };
    }
    throw err;
  }
}

/** POST /suites/import/validate: a suite zip read and checked without running its code. */
export function validateSuiteZip(file: File): Promise<SuiteZipValidation> {
  if (apiMode === 'live') {
    const body = new FormData();
    body.append('file', file);
    return apiSend('POST', '/suites/import/validate', body, SuiteZipValidationSchema);
  }
  return fixture(() => suiteZipValidationFixture(file.name, file.size), {
    request: 'POST /api/suites/import/validate',
    latencyMs: 900,
  });
}

/** POST /suites/import: the validated zip as the draft of a new suite. */
export function importSuiteZip(request: SuiteZipImportRequest): Promise<SuiteDraftView> {
  if (apiMode === 'live') return apiSend('POST', '/suites/import', request, SuiteDraftViewSchema);
  // Fixtures: the editor's draft world creates the draft, as a zip-made one.
  return drafts.createSuiteDraft({
    name: request.name,
    versionLabel: '0.1',
    from: { kind: 'zip', token: request.token, trustScripts: request.trustScripts },
  });
}
