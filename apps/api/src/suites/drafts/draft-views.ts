/**
 * The draft as the authoring pages see it (SA.1 to SA.3, SA.12): the task
 * table, the change list against the base, the suite-level problems that
 * block Review and save, and the conflict when the folder's current version
 * moved past the base. Pure functions over the rows the service loads.
 */
import { parseDocument } from 'yaml';
import {
  DIRECTORY_KEY_MESSAGE,
  DIRECTORY_KEY_PATTERN,
  SCORER_TYPES,
  type DraftChange,
  type DraftConflict,
  type DraftRef,
  type DraftSummary,
  type DraftSuiteProblem,
  type DraftTaskRow,
  type ScorerType,
  type SuiteDraftView,
} from '@hermes-evals/shared';
import { suiteChanges } from '../views/changes.js';
import { isoTime, suiteDisplayPath } from '../views/format.js';
import type { SuiteRow, TaskRow } from '../views/rows.js';
import { suiteRef } from '../views/suite-views.js';
import { isSaving, type DraftBase } from './draft-writer.js';
import type { DraftRow, DraftTaskDbRow, StoredDraft } from './draft-store.js';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** What a view needs beyond the draft and its base. */
export interface DraftViewInput {
  stored: StoredDraft;
  base: DraftBase;
  /** The folder's current version and its tasks, when it has one. */
  current: { suite: SuiteRow; tasks: TaskRow[] } | null;
  /** Restored-from task versions by task id, with their suite. */
  restored: ReadonlyMap<string, { task: TaskRow; suite: SuiteRow }>;
  nextVersion: number;
  /** The folder that holds the new suite's name already, if any (`invoices-v1`). */
  nameHolder: string | null;
  now: Date;
}

export function draftRef(draft: DraftRow, base: DraftBase, nextVersion: number): DraftRef {
  return {
    id: draft.id,
    folder: draft.sourcePath,
    path: suiteDisplayPath(draft.sourcePath),
    name: draft.name,
    baseVersion: base.suite?.versionNumber ?? null,
    nextVersion,
  };
}

/** task.yaml's summary and check types, as far as it parses. */
export function yamlFacts(taskYaml: string | null): { summary: string; types: ScorerType[] } {
  if (taskYaml === null) return { summary: '', types: [] };
  const doc = parseDocument(taskYaml);
  const raw: unknown = doc.errors.length > 0 ? null : doc.toJS();
  if (!isRecord(raw)) return { summary: '', types: [] };
  const types = (Array.isArray(raw.verification) ? raw.verification : [])
    .map((e) => (isRecord(e) ? e.type : null))
    .filter(
      (t): t is ScorerType =>
        typeof t === 'string' && (SCORER_TYPES as readonly string[]).includes(t),
    );
  return {
    summary: typeof raw.summary === 'string' ? raw.summary : '',
    types: [...new Set(types)],
  };
}

function taskRow(
  task: DraftTaskDbRow,
  input: DraftViewInput,
  baseById: ReadonlyMap<string, TaskRow>,
): DraftTaskRow {
  const facts = yamlFacts(task.taskYaml);
  const restored = task.restoredFromTaskId
    ? input.restored.get(task.restoredFromTaskId)
    : undefined;
  return {
    key: task.key,
    position: task.position,
    state: task.state,
    summary: facts.summary,
    verificationTypes: facts.types,
    fixtureCount: (input.stored.files.get(task.id) ?? []).filter((f) => f.kind === 'fixture')
      .length,
    baseVersion: task.baseTaskId ? (baseById.get(task.baseTaskId)?.versionNumber ?? null) : null,
    restoredFrom: restored
      ? { taskVersion: restored.task.versionNumber, suiteVersion: restored.suite.versionNumber }
      : null,
    readiness: task.readiness?.summary ?? 'not_run',
    updatedAt: isoTime(task.updatedAt),
  };
}

const blank = (text: string | null | undefined): string | null =>
  text === null || text === undefined || text.trim() === '' ? null : text;

/** The draft's changes against its base: tasks in draft order, then label, description and order. */
export function draftChanges(input: DraftViewInput): DraftChange[] {
  const { draft, tasks } = input.stored;
  const baseById = new Map(input.base.tasks.map((t) => [t.id, t]));
  const changes: DraftChange[] = [];
  for (const task of tasks) {
    const base = task.baseTaskId ? baseById.get(task.baseTaskId) : undefined;
    const restored = task.restoredFromTaskId
      ? input.restored.get(task.restoredFromTaskId)
      : undefined;
    switch (task.state) {
      case 'added':
        changes.push({
          kind: 'added',
          key: task.key,
          renamedFrom: base !== undefined && base.key !== task.key ? base.key : null,
        });
        break;
      case 'changed':
        changes.push({ kind: 'changed', key: task.key });
        break;
      case 'removed':
        changes.push({ kind: 'removed', key: base?.key ?? task.key });
        break;
      case 'restored':
        if (restored) {
          changes.push({
            kind: 'restored',
            key: task.key,
            fromTaskVersion: restored.task.versionNumber,
            fromSuiteVersion: restored.suite.versionNumber,
          });
        }
        break;
      case 'unchanged':
        break;
    }
  }
  const suite = input.base.suite;
  if (suite === null) return changes;
  if (draft.versionLabel !== suite.versionLabel) {
    changes.push({ kind: 'label', from: suite.versionLabel, to: draft.versionLabel });
  }
  if (blank(draft.description) !== blank(suite.description)) {
    changes.push({
      kind: 'description',
      from: blank(suite.description),
      to: blank(draft.description),
    });
  }
  // The order of the tasks both keep, as the draft lists them against the base.
  const kept = new Set(
    tasks.filter((t) => t.state !== 'removed' && t.state !== 'added').map((t) => t.key),
  );
  const before = input.base.tasks.map((t) => t.key).filter((k) => kept.has(k));
  const after = tasks.map((t) => t.key).filter((k) => kept.has(k));
  if (before.join('\n') !== after.join('\n')) changes.push({ kind: 'order' });
  return changes;
}

/** What blocks Review and save at the suite level (SA.2, SA.3); a task's problems never do. */
export function suiteProblems(input: DraftViewInput): DraftSuiteProblem[] {
  const { draft, tasks } = input.stored;
  const problems: DraftSuiteProblem[] = [];
  if (!DIRECTORY_KEY_PATTERN.test(draft.name)) {
    problems.push({ code: 'name_invalid', message: DIRECTORY_KEY_MESSAGE });
  }
  if (input.nameHolder !== null) {
    problems.push({
      code: 'name_taken',
      message: `${draft.name} is already used by ${suiteDisplayPath(input.nameHolder)}.`,
    });
  }
  if (draft.versionLabel.trim() === '') {
    problems.push({ code: 'label_empty', message: 'Add a version label.' });
  }
  if (!tasks.some((t) => t.state !== 'removed')) {
    problems.push({
      code: 'no_tasks',
      message: `Add at least one task to save v${input.nextVersion}.`,
    });
  }
  return problems;
}

/** The keys the draft changed: added, changed, removed or restored. */
export const draftKeys = (stored: StoredDraft): string[] =>
  stored.tasks.filter((t) => t.state !== 'unchanged').map((t) => t.key);

/**
 * Whether the draft and the folder's current version agree on a task they
 * both touched (Phase 5b question 6): both removed it, or both made it the
 * same bytes under the same key (the loader's content hash, which the draft
 * task keeps). Either choice in Combine would give the same task, so it
 * needs none. A rename made on both sides still asks.
 */
function bothAgree(
  task: DraftTaskDbRow,
  baseKey: string | null,
  current: ReadonlyMap<string, TaskRow>,
): boolean {
  if (task.state === 'removed') return !current.has(baseKey ?? task.key);
  if (baseKey !== null && baseKey !== task.key) return false;
  const now = current.get(task.key);
  return now !== undefined && task.contentHash !== null && now.contentHash === task.contentHash;
}

/**
 * The conflict of an edit draft whose folder's current version is no longer
 * its base (SA.12): what the current version changed against the base, and
 * the tasks both sides changed differently. Null while the base is current.
 */
export function draftConflict(
  input: Pick<DraftViewInput, 'stored' | 'base' | 'current'>,
  cause: DraftConflict['cause'] = 'version_moved',
): DraftConflict | null {
  const { current, base } = input;
  if (base.suite === null || current === null || current.suite.id === base.suite.id) return null;
  const diskChanges = suiteChanges(base.tasks, current.tasks);
  const touched = new Set([...diskChanges.added, ...diskChanges.removed, ...diskChanges.changed]);
  const baseById = new Map(base.tasks.map((t) => [t.id, t]));
  const keys = draftKeys(input.stored);
  const currentByKey = new Map(current.tasks.map((t) => [t.key, t]));
  const overlap = input.stored.tasks
    .filter((t) => t.state !== 'unchanged')
    .filter((t) => {
      const baseKey = t.baseTaskId === null ? null : (baseById.get(t.baseTaskId)?.key ?? null);
      const both = touched.has(t.key) || (baseKey !== null && touched.has(baseKey));
      return both && !bothAgree(t, baseKey, currentByKey);
    })
    .map((t) => t.key);
  return {
    cause,
    baseVersion: base.suite.versionNumber,
    current: { ...suiteRef(current.suite), loadedAt: isoTime(current.suite.loadedAt) },
    diskChanges,
    draftKeys: keys,
    overlap,
  };
}

export function draftView(input: DraftViewInput): SuiteDraftView {
  const { draft, tasks } = input.stored;
  const baseById = new Map(input.base.tasks.map((t) => [t.id, t]));
  return {
    id: draft.id,
    folder: draft.sourcePath,
    path: suiteDisplayPath(draft.sourcePath),
    name: draft.name,
    origin: draft.origin,
    base: input.base.suite ? suiteRef(input.base.suite) : null,
    nextVersion: input.nextVersion,
    versionLabel: draft.versionLabel,
    description: draft.description,
    changes: draftChanges(input),
    tasks: tasks.map((t) => taskRow(t, input, baseById)),
    problems: suiteProblems(input),
    conflict: draftConflict(input),
    saving:
      draft.saveStartedAt !== null && isSaving(draft, input.now)
        ? (draft.saveProgress ?? {
            startedAt: isoTime(draft.saveStartedAt),
            step: 'staging',
            selfChecks: null,
          })
        : null,
    revision: draft.revision,
    createdAt: isoTime(draft.createdAt),
    updatedAt: isoTime(draft.updatedAt),
  };
}

export function draftSummary(view: SuiteDraftView): DraftSummary {
  return {
    id: view.id,
    folder: view.folder,
    path: view.path,
    name: view.name,
    origin: view.origin,
    baseVersion: view.base?.versionNumber ?? null,
    changeCount: view.changes.length,
    taskCount: view.tasks.filter((t) => t.state !== 'removed').length,
    conflict: view.conflict !== null,
    updatedAt: view.updatedAt,
  };
}
