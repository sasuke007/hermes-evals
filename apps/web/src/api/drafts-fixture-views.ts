/**
 * The views the API answers with, built from the fixture draft world (./drafts-fixtures.ts):
 * the suite draft with its change list and suite-level problems (SA.3), its summary for the
 * suite list's chip (SA.1), and each task with its files and readiness (SA.4 to SA.8).
 */
import type {
  DraftChange,
  DraftFileView,
  DraftRef,
  DraftSuiteProblem,
  DraftSummary,
  DraftTaskDetail,
  DraftTaskRow,
  SuiteDraftView,
} from './types/authoring';
import { fixtureReadiness } from './drafts-fixture-checks';
import { fileView } from './drafts-fixture-tasks';
import { nowIso, stateOf, type FixtureDraft, type FixtureTask } from './drafts-fixtures';

const bytes = (text: string): number => new TextEncoder().encode(text).length;
const lines = (text: string): string => {
  const n = text.split('\n').filter((l, i, all) => i < all.length - 1 || l !== '').length;
  return `Text · ${n} ${n === 1 ? 'line' : 'lines'}`;
};

/** The text files the forms edit, first in the Files tab. */
function textFiles(task: FixtureTask): DraftFileView[] {
  const out: DraftFileView[] = [];
  if (task.prompt !== null)
    out.push(fileView('prompt.md', 'prompt', bytes(task.prompt), 'Markdown'));
  if (task.reference !== null)
    out.push(fileView('reference.json', 'reference', bytes(task.reference), 'JSON'));
  out.push(fileView('task.yaml', 'task_yaml', bytes(task.taskYaml), 'YAML'));
  for (const rubric of task.rubrics)
    out.push(fileView(rubric.path, 'rubric', bytes(rubric.text), lines(rubric.text)));
  return out;
}

export function draftRef(draft: FixtureDraft): DraftRef {
  return {
    id: draft.id,
    folder: draft.folder,
    path: `./suites/${draft.folder}`,
    name: draft.name,
    baseVersion: draft.base?.versionNumber ?? null,
    nextVersion: nextVersion(draft),
  };
}

function nextVersion(draft: FixtureDraft): number {
  if (draft.conflict) return draft.conflict.current.versionNumber + 1;
  return (draft.base?.versionNumber ?? 0) + 1;
}

export function taskDetailView(draft: FixtureDraft, task: FixtureTask): DraftTaskDetail {
  const readiness = fixtureReadiness({
    key: task.key,
    form: task.form,
    lock: task.lock,
    prompt: task.prompt,
    reference: task.reference,
    files: task.files,
    texts: task.texts,
    selfCheck: task.selfCheck,
    otherKeys: draft.tasks.filter((t) => t !== task).map((t) => t.key),
    now: task.updatedAt,
    refused: task.refused ?? [],
  });
  return {
    draft: draftRef(draft),
    key: task.key,
    position: task.position,
    state: stateOf(task),
    base: task.base,
    restoredFrom: task.restoredFrom,
    taskYaml: task.taskYaml,
    prompt: task.prompt,
    reference: task.reference,
    rubrics: structuredClone(task.rubrics),
    form: task.lock ? null : structuredClone(task.form),
    formLock: task.lock ? { ...task.lock } : null,
    files: [...textFiles(task), ...task.files.map((f) => ({ ...f }))],
    readiness,
    selfCheck: task.selfCheck ? structuredClone(task.selfCheck) : null,
    revision: task.revision,
    updatedAt: task.updatedAt,
  };
}

export function taskRowView(draft: FixtureDraft, task: FixtureTask): DraftTaskRow {
  const detail = taskDetailView(draft, task);
  const state = stateOf(task);
  // Untouched tasks keep their last self-check's result (SA.3): the base was loaded valid.
  const readiness = state === 'unchanged' ? 'ready' : detail.readiness.summary;
  return {
    key: task.key,
    position: task.position,
    state,
    summary: task.form.summary,
    verificationTypes: task.form.checks.map((c) => c.type),
    fixtureCount: task.files.filter((f) => f.kind === 'fixture').length,
    baseVersion: task.base?.version ?? null,
    restoredFrom: task.restoredFrom,
    readiness,
    updatedAt: task.updatedAt,
  };
}

function changesOf(draft: FixtureDraft): DraftChange[] {
  const changes: DraftChange[] = [];
  for (const task of draft.tasks) {
    const state = stateOf(task);
    if (state === 'added') {
      const renamedFrom = task.base && task.base.key !== task.key ? task.base.key : null;
      changes.push({ kind: 'added', key: task.key, renamedFrom });
    } else if (state === 'changed') changes.push({ kind: 'changed', key: task.key });
    else if (state === 'removed') changes.push({ kind: 'removed', key: task.key });
    else if (state === 'restored' && task.restoredFrom) {
      changes.push({
        kind: 'restored',
        key: task.key,
        fromTaskVersion: task.restoredFrom.taskVersion,
        fromSuiteVersion: task.restoredFrom.suiteVersion,
      });
    }
  }
  if (draft.base && draft.versionLabel !== (draft.baseLabel ?? '')) {
    changes.push({ kind: 'label', from: draft.baseLabel, to: draft.versionLabel });
  }
  if (draft.base && (draft.description ?? null) !== (draft.baseDescription ?? null)) {
    changes.push({ kind: 'description', from: draft.baseDescription, to: draft.description });
  }
  // Task changes by kind as SA.3 lists them (added, then changed or restored, then removed).
  const rank = { added: 0, changed: 1, restored: 1, removed: 2 } as Record<string, number>;
  changes.sort((a, b) => (rank[a.kind] ?? 3) - (rank[b.kind] ?? 3));
  const kept = [...draft.tasks]
    .sort((a, b) => a.position - b.position)
    .filter((t) => t.base && t.base.key === t.key)
    .map((t) => t.key);
  const baseKept = draft.baseOrder.filter((k) => kept.includes(k));
  if (draft.base && kept.join() !== baseKept.join()) changes.push({ kind: 'order' });
  return changes;
}

function problemsOf(draft: FixtureDraft): DraftSuiteProblem[] {
  const problems: DraftSuiteProblem[] = [];
  if (draft.versionLabel.trim() === '')
    problems.push({ code: 'label_empty', message: 'Add a version label.' });
  if (draft.tasks.filter((t) => !t.removed).length === 0) {
    const next = nextVersion(draft);
    problems.push({ code: 'no_tasks', message: `Add at least one task to save v${next}.` });
  }
  return problems;
}

export function draftView(draft: FixtureDraft): SuiteDraftView {
  const tasks = [...draft.tasks].sort(
    (a, b) => a.position - b.position || a.key.localeCompare(b.key),
  );
  return {
    id: draft.id,
    folder: draft.folder,
    path: `./suites/${draft.folder}`,
    name: draft.name,
    origin: draft.origin,
    base: draft.base ? { ...draft.base } : null,
    nextVersion: nextVersion(draft),
    versionLabel: draft.versionLabel,
    description: draft.description,
    changes: changesOf(draft),
    tasks: tasks.map((t) => taskRowView(draft, t)),
    problems: problemsOf(draft),
    conflict: draft.conflict ? structuredClone(draft.conflict) : null,
    saving: draft.saving ? { ...draft.saving } : null,
    revision: draft.revision,
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
  };
}

export function draftSummary(draft: FixtureDraft): DraftSummary {
  const view = draftView(draft);
  return {
    id: draft.id,
    folder: draft.folder,
    path: view.path,
    name: draft.name,
    origin: draft.origin,
    baseVersion: draft.base?.versionNumber ?? null,
    changeCount: view.changes.length,
    taskCount: draft.tasks.filter((t) => !t.removed).length,
    conflict: draft.conflict !== null,
    updatedAt: draft.updatedAt,
  };
}

/** Marks a write: the draft and the task move on, and a self-check of older content is out of date. */
export function touch(draft: FixtureDraft, task?: FixtureTask): void {
  const now = nowIso();
  draft.revision += 1;
  draft.updatedAt = now;
  if (task) {
    task.revision += 1;
    task.updatedAt = now;
    if (task.selfCheck) task.selfCheck.current = false;
  }
}
