/**
 * Suite authoring fixtures of the pages around the editor (Phase 5b; boards SA.1 and SA.11):
 * folders gone from disk, a Reload all in progress, and the states of Review and save that
 * the editor's draft world (src/api/drafts-fixtures.ts) does not draw. Imports are in
 * ./suites-import.ts.
 *
 * Scenarios handled here (SUITE_AUTHORING_SCENARIOS in ./suites-authoring-scenarios.ts):
 * draft-invalid-task, draft-no-changes, save-failed, missing-folders; and draft-conflict and
 * draft-conflict-overlap, which the editor's world draws, here move the folder on to v2 so
 * the version on disk can be read.
 */
import type { DraftSaveFailureBody } from '@/api/types/authoring';
import type { SuiteChangeSet, SuiteListRow, SuiteReloadProgress } from '@/api/types/suites';
import { at, sha, suiteListFixture, ulid, type SuiteState } from './suites';

const emptyChanges = (): SuiteChangeSet => ({
  added: [],
  removed: [],
  changed: [],
  nowInvalid: [],
  nowValid: [],
});

/** Which save state the active scenarios select. */
export interface DraftFixtureState {
  invalidTask: boolean;
  noChanges: boolean;
  saveFailed: boolean;
  conflict: 'none' | 'disjoint' | 'overlap';
}

export function draftStateFrom(active: (name: string) => boolean): DraftFixtureState {
  return {
    invalidTask: active('draft-invalid-task'),
    noChanges: active('draft-no-changes'),
    saveFailed: active('save-failed'),
    conflict: active('draft-conflict-overlap')
      ? 'overlap'
      : active('draft-conflict')
        ? 'disjoint'
        : 'none',
  };
}

/**
 * The suite state behind a conflict: a reload created v2 after the draft began, with
 * late_fees changed (disjoint) or total_due changed (overlap).
 */
export function suiteStateForDraft(draft: DraftFixtureState, state: SuiteState): SuiteState {
  if (draft.conflict === 'disjoint') return 'invalid-task';
  if (draft.conflict === 'overlap') return 'newer-version';
  return state;
}

/** The 422 of a save whose staging folder failed to load (`save-failed`). */
export const SAVE_FAILURE: DraftSaveFailureBody = {
  statusCode: 422,
  message: '`overdue_count/task.yaml` line 9: unknown key `prmary`',
  step: 'loading',
  error: {
    file: 'overdue_count/task.yaml',
    line: 9,
    column: 7,
    message: 'unknown key prmary',
    excerpt: [{ line: 9, text: '    prmary: true', highlight: true }],
  },
};

/** Folders the stack lists as missing from disk (the `missing-folders` scenario). */
export const MISSING_FOLDERS = ['zz-smoke-mcp-1', 'zz-smoke-mcp-2', 'zz-smoke-reload'];

/** Suite rows for folders whose last load found them gone. */
export function missingFolderRows(): SuiteListRow[] {
  const template = suiteListFixture('v1')[0]!;
  return MISSING_FOLDERS.map((name, i) => ({
    ...template,
    suiteId: ulid('suite', name),
    name,
    path: `./suites/${name}`,
    versionNumber: 1,
    versionLabel: '0.1',
    contentHash: sha(name),
    description: '',
    taskCount: 2,
    validCount: 2,
    verificationTypes: ['exact_match'],
    loadedAt: at(22, `0${i + 1}:00`),
    lastLoad: {
      outcome: 'missing',
      at: at(23, '09:12'),
      changes: emptyChanges(),
      error: null,
      servedVersion: null,
    },
    currentChanges: { ...emptyChanges(), added: ['t1', 't2'] },
  }));
}

/** GET /suites/reload/progress while Reload all runs: the first folder loading, the rest queued. */
export function reloadProgressFixture(paths: readonly string[]): SuiteReloadProgress {
  return {
    active: true,
    startedAt: at(23, '15:41'),
    finishedAt: null,
    directories: paths.map((sourcePath, i) => ({
      sourcePath,
      name: sourcePath.replace(/^\.\/suites\//, ''),
      state: i === 0 ? 'loading' : 'queued',
      entry: null,
      error: null,
    })),
  };
}
