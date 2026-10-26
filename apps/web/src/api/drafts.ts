/**
 * Suite drafts (plan 4.6 and 11, Phase 5b): the open drafts, a draft's details and order,
 * its tasks with their text files, files, readiness, self-check and Try it, the task diff,
 * Review, Save and combining onto a newer version, and a version's download. Suites are
 * addressed by folder name (`invoices-v1`). Nothing here calls a model: Try it scores in the
 * API and the self-check runs in the worker.
 *
 * Live mode calls the endpoints through apiGet/apiSend and parses every answer with its
 * shared schema; Save and Rebase also parse the 409 and 422 bodies they are designed to
 * answer (DraftConflictBody, DraftSaveFailureBody). A file upload goes through
 * ./drafts-upload.ts for its progress. Fixtures mode serves the in-memory draft world of
 * ./drafts-fixtures.ts, whose edits stick while the page is open (src/api/README.md):
 * `draftOps` (./drafts-fixture-ops.ts) and `draftSave` (./drafts-fixture-save.ts) of the
 * fixture world, which a live build leaves out.
 */
import {
  DraftConflictBodySchema,
  DraftReviewSchema,
  DraftSaveFailureBodySchema,
  DraftSaveResultSchema,
  DraftSelfCheckViewSchema,
  DraftSummarySchema,
  DraftTaskCreateResultSchema,
  DraftTaskDetailSchema,
  DraftTaskDiffSchema,
  SuiteDraftViewSchema,
  suiteVersionZipName,
  TablePreviewSchema,
  TaskReadinessSchema,
  TryCheckResultSchema,
} from '@hermes-evals/shared';
import type {
  CreateDraftTaskRequest,
  CreateSuiteDraftRequest,
  DraftConflictBody,
  DraftReview,
  DraftSaveFailureBody,
  DraftSaveResult,
  DraftSelfCheckView,
  DraftSummary,
  DraftTaskCreateResult,
  DraftTaskDetail,
  DraftTaskDiff,
  MoveDraftFileRequest,
  RebaseSuiteDraftRequest,
  SaveSuiteDraftRequest,
  SuiteDraftView,
  TaskReadiness,
  TryCheckRequest,
  TryCheckResult,
  UpdateDraftTaskRequest,
  UpdateSuiteDraftRequest,
} from './types/authoring';
import type { TablePreview } from './types/suites';
import { API_BASE, apiGet, apiGetText, apiSend, type TextStart } from './client';
import { sendWithFailures } from './drafts-upload';
import { apiMode, fixture } from './source';

/** One path segment; a file path's slashes are encoded too (`fixtures%2Finvoices.csv`). */
const seg = (value: string): string => encodeURIComponent(value);
export const draftPath = (folder: string): string => `/suites/${seg(folder)}/draft`;
export const draftTaskPath = (folder: string, key: string): string =>
  `${draftPath(folder)}/tasks/${seg(key)}`;
const filePath = (folder: string, key: string, path: string): string =>
  `${draftTaskPath(folder, key)}/files/${seg(path)}`;
/** "GET /api/suites/invoices-v1/draft": how a fixture names the request it stands in for. */
const req = (method: string, path: string): string => `${method} ${API_BASE}${path}`;

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

/** GET /suites/drafts: every open draft, for the suite list's chip and unsaved new suites. */
export function listDrafts(): Promise<DraftSummary[]> {
  if (apiMode === 'live') return apiGet('/suites/drafts', DraftSummarySchema.array());
  return fixture(({ draftSave }) => draftSave.listDrafts(), { request: 'GET /api/suites/drafts' });
}

/** POST /suites/drafts: a new suite, empty, a copy of a suite, or a validated zip (SA.2). */
export function createSuiteDraft(body: CreateSuiteDraftRequest): Promise<SuiteDraftView> {
  if (apiMode === 'live') return apiSend('POST', '/suites/drafts', body, SuiteDraftViewSchema);
  return fixture(({ draftSave }) => draftSave.createDraft(body), {
    request: 'POST /api/suites/drafts',
  });
}

/** POST /suites/:suite/draft: the draft of a folder, opened on its current version if none is. */
export function openSuiteDraft(folder: string): Promise<SuiteDraftView> {
  if (apiMode === 'live') return apiSend('POST', draftPath(folder), {}, SuiteDraftViewSchema);
  return fixture(({ draftSave }) => draftSave.openDraft(folder), {
    request: req('POST', draftPath(folder)),
  });
}

/** GET /suites/:suite/draft; 404 when the folder has no draft. */
export function getSuiteDraft(folder: string): Promise<SuiteDraftView> {
  if (apiMode === 'live') return apiGet(draftPath(folder), SuiteDraftViewSchema);
  return fixture(({ draftSave }) => draftSave.getDraft(folder), {
    request: req('GET', draftPath(folder)),
  });
}

/** PATCH /suites/:suite/draft: Edit details (label, description) and the task order. */
export function updateSuiteDraft(
  folder: string,
  body: UpdateSuiteDraftRequest,
): Promise<SuiteDraftView> {
  if (apiMode === 'live') return apiSend('PATCH', draftPath(folder), body, SuiteDraftViewSchema);
  return fixture(({ draftOps }) => draftOps.patchDraft(folder, body), {
    request: req('PATCH', draftPath(folder)),
  });
}

/** DELETE /suites/:suite/draft: discard; nothing on disk changes. */
export function discardSuiteDraft(folder: string): Promise<void> {
  if (apiMode === 'live') return apiSend('DELETE', draftPath(folder));
  return fixture(({ draftSave }) => draftSave.discardDraft(folder), {
    request: req('DELETE', draftPath(folder)),
  });
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

/** POST …/draft/tasks: a blank task, a duplicate, a restore of an older version, or a copy. */
export function createDraftTask(
  folder: string,
  body: CreateDraftTaskRequest,
): Promise<DraftTaskCreateResult> {
  const path = `${draftPath(folder)}/tasks`;
  if (apiMode === 'live') return apiSend('POST', path, body, DraftTaskCreateResultSchema);
  return fixture(({ draftOps }) => draftOps.createTask(folder, body), {
    request: req('POST', path),
  });
}

/** GET …/draft/tasks/:key: the task editor's whole picture. */
export function getDraftTask(folder: string, key: string): Promise<DraftTaskDetail> {
  const path = draftTaskPath(folder, key);
  if (apiMode === 'live') return apiGet(path, DraftTaskDetailSchema);
  return fixture(({ draftOps }) => draftOps.getTask(folder, key), { request: req('GET', path) });
}

/** PUT …/draft/tasks/:key: what changed, as the editor autosaves it (form or task.yaml). */
export function updateDraftTask(
  folder: string,
  key: string,
  body: UpdateDraftTaskRequest,
): Promise<DraftTaskDetail> {
  const path = draftTaskPath(folder, key);
  if (apiMode === 'live') return apiSend('PUT', path, body, DraftTaskDetailSchema);
  return fixture(({ draftOps }) => draftOps.putTask(folder, key, body), {
    request: req('PUT', path),
  });
}

/** DELETE …/draft/tasks/:key: marks a base task removed, drops an added one. */
export function removeDraftTask(folder: string, key: string): Promise<SuiteDraftView> {
  const path = draftTaskPath(folder, key);
  if (apiMode === 'live') return apiSend('DELETE', path, undefined, SuiteDraftViewSchema);
  return fixture(({ draftOps }) => draftOps.deleteTask(folder, key), {
    request: req('DELETE', path),
  });
}

/** POST …/draft/tasks/:key/revert: the base version's files again ("Revert to v6"). */
export function revertDraftTask(folder: string, key: string): Promise<DraftTaskDetail> {
  const path = `${draftTaskPath(folder, key)}/revert`;
  if (apiMode === 'live') return apiSend('POST', path, {}, DraftTaskDetailSchema);
  return fixture(({ draftOps }) => draftOps.revertTask(folder, key), {
    request: req('POST', path),
  });
}

/** PATCH …/files/:path: rename or move a file within the task folder. */
export function moveDraftFile(
  folder: string,
  key: string,
  path: string,
  body: MoveDraftFileRequest,
): Promise<DraftTaskDetail> {
  const url = filePath(folder, key, path);
  if (apiMode === 'live') return apiSend('PATCH', url, body, DraftTaskDetailSchema);
  return fixture(({ draftOps }) => draftOps.moveFile(folder, key, path, body.path), {
    request: req('PATCH', url),
  });
}

/** DELETE …/files/:path. */
export function deleteDraftFile(
  folder: string,
  key: string,
  path: string,
): Promise<DraftTaskDetail> {
  const url = filePath(folder, key, path);
  if (apiMode === 'live') return apiSend('DELETE', url, undefined, DraftTaskDetailSchema);
  return fixture(({ draftOps }) => draftOps.deleteFile(folder, key, path), {
    request: req('DELETE', url),
  });
}

/** The URL of a draft file's bytes, for a download link. */
export function draftFileUrl(folder: string, key: string, path: string): string {
  return `${API_BASE}${filePath(folder, key, path)}`;
}

/** A draft file read as text up to `maxBytes`: a verifier's source, shown read-only (V6). */
export function getDraftFileText(
  folder: string,
  key: string,
  path: string,
  maxBytes = 256 * 1024,
): Promise<TextStart> {
  const url = filePath(folder, key, path);
  if (apiMode === 'live') return apiGetText(url, maxBytes);
  return fixture(
    ({ draftOps }) => {
      const text = draftOps.fileText(folder, key, path) ?? '';
      return { text: text.slice(0, maxBytes), truncated: text.length > maxBytes };
    },
    { request: req('GET', url) },
  );
}

/** GET …/files/:path/preview: the first rows of a CSV or TSV file, null for any other. */
export function getDraftFilePreview(
  folder: string,
  key: string,
  path: string,
): Promise<TablePreview | null> {
  const url = `${filePath(folder, key, path)}/preview`;
  if (apiMode === 'live') return apiGet(url, TablePreviewSchema.nullable());
  return fixture(
    ({ draftOps }) => {
      const text = draftOps.fileText(folder, key, path);
      if (text === null || !/\.(csv|tsv)$/i.test(path)) return null;
      const lines = text.split('\n').filter((l) => l.trim() !== '');
      const split = (l: string) => l.split(path.endsWith('.tsv') ? '\t' : ',');
      return {
        columns: split(lines[0] ?? ''),
        rows: lines.slice(1, 6).map(split),
        totalRows: lines.length - 1,
      };
    },
    { request: req('GET', url) },
  );
}

/** GET …/tasks/:key/readiness: the 13 rules on their own. */
export function getDraftTaskReadiness(folder: string, key: string): Promise<TaskReadiness> {
  const url = `${draftTaskPath(folder, key)}/readiness`;
  if (apiMode === 'live') return apiGet(url, TaskReadinessSchema);
  return fixture(({ draftOps }) => draftOps.getTask(folder, key).readiness, {
    request: req('GET', url),
  });
}

/** POST …/tasks/:key/self-check: file checks and scripts in the worker; 503 without one. */
export function runDraftSelfCheck(folder: string, key: string): Promise<DraftSelfCheckView> {
  const url = `${draftTaskPath(folder, key)}/self-check`;
  if (apiMode === 'live') return apiSend('POST', url, {}, DraftSelfCheckViewSchema);
  return fixture(({ draftOps }) => draftOps.selfCheck(folder, key), {
    request: req('POST', url),
    latencyMs: 900,
  });
}

/** POST …/tasks/:key/try: an answer check on the reference (reply null) or a pasted reply. */
export function tryDraftCheck(
  folder: string,
  key: string,
  body: TryCheckRequest,
): Promise<TryCheckResult> {
  const url = `${draftTaskPath(folder, key)}/try`;
  if (apiMode === 'live') return apiSend('POST', url, body, TryCheckResultSchema);
  return fixture(({ draftOps }) => draftOps.tryCheck(folder, key, body), {
    request: req('POST', url),
  });
}

/** GET …/tasks/:key/diff: the draft task against its base version. */
export function getDraftTaskDiff(folder: string, key: string): Promise<DraftTaskDiff> {
  const url = `${draftTaskPath(folder, key)}/diff`;
  if (apiMode === 'live') return apiGet(url, DraftTaskDiffSchema);
  return fixture(({ draftSave }) => draftSave.taskDiff(folder, key), { request: req('GET', url) });
}

// ---------------------------------------------------------------------------
// Review, save, rebase, download
// ---------------------------------------------------------------------------

/** GET /suites/:suite/draft/review: what Save writes and what it creates (SA.11). */
export function getDraftReview(folder: string): Promise<DraftReview> {
  const url = `${draftPath(folder)}/review`;
  if (apiMode === 'live') return apiGet(url, DraftReviewSchema);
  return fixture(({ draftSave }) => draftSave.review(folder), { request: req('GET', url) });
}

/** What Save answered: the new version, the conflict that stopped it, or the loader's 422. */
export type DraftSaveOutcome =
  | { kind: 'saved'; result: DraftSaveResult }
  | { kind: 'conflict'; body: DraftConflictBody }
  | { kind: 'not_saved'; body: DraftSaveFailureBody };

/**
 * POST /suites/:suite/draft/save. A 409 (the folder moved past the base) and a 422 (the
 * staging folder failed the loader; nothing on disk changed) come back as outcomes; any
 * other failure, a 503 without a worker included, is thrown as an ApiError.
 */
export async function saveSuiteDraft(
  folder: string,
  body: SaveSuiteDraftRequest,
): Promise<DraftSaveOutcome> {
  const url = `${draftPath(folder)}/save`;
  if (apiMode === 'live') {
    const answer = await sendWithFailures('POST', url, body, DraftSaveResultSchema, {
      409: DraftConflictBodySchema,
      422: DraftSaveFailureBodySchema,
    });
    if (answer.ok) return { kind: 'saved', result: answer.value };
    if (answer.status === 409) return { kind: 'conflict', body: answer.body as DraftConflictBody };
    return { kind: 'not_saved', body: answer.body as DraftSaveFailureBody };
  }
  return fixture(
    ({ draftSave }): DraftSaveOutcome => {
      const outcome = draftSave.save(folder, body);
      return outcome.ok
        ? { kind: 'saved', result: outcome.result }
        : { kind: 'conflict', body: outcome.conflict };
    },
    { request: req('POST', url), latencyMs: 1600 },
  );
}

/** What Combine answered: the draft on the newer version, or a newer conflict still. */
export type DraftRebaseOutcome =
  { kind: 'rebased'; draft: SuiteDraftView } | { kind: 'conflict'; body: DraftConflictBody };

/** POST /suites/:suite/draft/rebase: combine onto `onto`, one side kept per overlapping task. */
export async function rebaseSuiteDraft(
  folder: string,
  body: RebaseSuiteDraftRequest,
): Promise<DraftRebaseOutcome> {
  const url = `${draftPath(folder)}/rebase`;
  if (apiMode === 'live') {
    const answer = await sendWithFailures('POST', url, body, SuiteDraftViewSchema, {
      409: DraftConflictBodySchema,
    });
    if (answer.ok) return { kind: 'rebased', draft: answer.value };
    return { kind: 'conflict', body: answer.body as DraftConflictBody };
  }
  return fixture(
    ({ draftSave }): DraftRebaseOutcome => ({
      kind: 'rebased',
      draft: draftSave.rebase(folder, body),
    }),
    { request: req('POST', url) },
  );
}

/** GET /suites/:suite/versions/:n/zip, with the file name the download gets (SA.10). */
export function suiteVersionZip(
  folder: string,
  versionNumber: number,
): { url: string; fileName: string } {
  return {
    url: `${API_BASE}/suites/${seg(folder)}/versions/${versionNumber}/zip`,
    fileName: suiteVersionZipName(folder, versionNumber),
  };
}
