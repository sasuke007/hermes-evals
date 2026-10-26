/**
 * Review and save (SA.11), before the save: each change with its one-line
 * summary, the files the save writes to the folder (files the UI does not
 * manage, verify/ scripts and a README, are kept as they are and not
 * listed), each touched task's readiness, and the tasks that would be
 * stored invalid ("Save with 1 invalid task?"): those with a problem the
 * loader would also find, which an upload refused for its size is not.
 */
import {
  refusedUploadMessage,
  type DraftChange,
  type DraftReview,
  type DraftWrite,
  type ReadinessRuleResult,
  type SuiteDraftView,
  type TaskReadiness,
} from '@hermes-evals/shared';
import { suiteDisplayPath } from '../views/format.js';
import { folderFiles, utf8Size, type FolderFile } from './draft-folder.js';
import type { DraftTaskDbRow } from './draft-store.js';
import { yamlFacts } from './draft-views.js';
import type { DraftTaskFolder } from './materialise.js';

const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`;

export interface ReviewTask {
  row: DraftTaskDbRow;
  folder: DraftTaskFolder;
  /** The base version's folder of this task (by its base key), when there is one. */
  base: DraftTaskFolder | null;
}

const sizeOf = (f: FolderFile): number => (f.text !== null ? utf8Size(f.text) : f.ref.size);
const hashOf = (f: FolderFile): string => (f.text !== null ? `text:${f.text}` : f.ref.sha256);

/** Files of `after` that differ from `before`, as writes under `root`. */
function fileWrites(
  root: string,
  before: DraftTaskFolder | null,
  after: DraftTaskFolder,
): DraftWrite[] {
  const old = new Map((before ? folderFiles(before) : []).map((f) => [f.path, f]));
  return folderFiles(after).flatMap((f): DraftWrite[] => {
    const was = old.get(f.path);
    if (was && hashOf(was) === hashOf(f)) return [];
    return [
      {
        op: was ? 'change' : 'add',
        path: `${root}/${f.path}`,
        beforeBytes: was ? sizeOf(was) : null,
        afterBytes: sizeOf(f),
        note: null,
      },
    ];
  });
}

/** Paths that changed against the base: "prompt.md changed · fixtures/notes.txt added". */
function changedFiles(before: DraftTaskFolder | null, after: DraftTaskFolder): string {
  const old = new Map((before ? folderFiles(before) : []).map((f) => [f.path, f]));
  const now = new Map(folderFiles(after).map((f) => [f.path, f]));
  const changed = [...now]
    .filter(([p, f]) => old.has(p) && hashOf(old.get(p)!) !== hashOf(f))
    .map(([p]) => p);
  const added = [...now.keys()].filter((p) => !old.has(p));
  const removed = [...old.keys()].filter((p) => !now.has(p));
  return [
    changed.length > 0 ? `${changed.join(', ')} changed` : '',
    added.length > 0 ? `${added.join(', ')} added` : '',
    removed.length > 0 ? `${removed.join(', ')} removed` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

/** The readiness in a few words: "self-check passed", "reference passes `answer`", "2 problems". */
function readinessNote(readiness: TaskReadiness | null): string {
  if (readiness === null) return 'not checked yet';
  const { counts } = readiness;
  if (counts.problems > 0) return plural(counts.problems, 'problem');
  if (counts.warnings > 0) return plural(counts.warnings, 'warning');
  const row = readiness.rules.find((r) => r.rule === 'self_check')!;
  if (row.status === 'pending') return 'self-check not run';
  if (readiness.needsWorker) return 'self-check passed';
  const lead = row.message.split(' · ')[0]!;
  return lead.charAt(0).toLowerCase() + lead.slice(1);
}

/**
 * The problem rows the loader would also find. An upload refused for its
 * size is a `file_limits` problem that leaves no file behind, so a row that
 * holds nothing else does not make the task load invalid.
 */
function loaderProblems(row: DraftTaskDbRow): ReadinessRuleResult[] {
  const readiness = row.readiness;
  if (readiness === null) return [];
  const refused = new Set(row.refusedUploads.map(refusedUploadMessage));
  const onlyRefused = readiness.issues
    .filter((i) => i.rule === 'file_limits' && i.severity === 'problem')
    .every((i) => refused.has(i.message));
  return readiness.rules.filter(
    (r) => r.status === 'problem' && !(r.rule === 'file_limits' && onlyRefused),
  );
}

/** Why a task would be stored invalid: its first problem ("self-check failed" for rows 12 and 13). */
function invalidReason(first: ReadinessRuleResult): string {
  return first.rule === 'self_check' || first.rule === 'negative_control'
    ? 'self-check failed'
    : first.message;
}

export function draftReview(view: SuiteDraftView, tasks: readonly ReviewTask[]): DraftReview {
  const root = suiteDisplayPath(view.folder);
  const byKey = new Map(tasks.map((t) => [t.row.key, t]));
  const isNew = view.base === null;
  const detail = (change: DraftChange): string => {
    switch (change.kind) {
      case 'added': {
        const t = byKey.get(change.key)!;
        const checks = yamlFacts(t.folder.taskYaml).types.length;
        const facts = `new task · ${plural(folderFiles(t.folder).length, 'file')} · ${plural(checks, 'check')}`;
        return change.renamedFrom ? `renamed from ${change.renamedFrom} · ${facts}` : facts;
      }
      case 'changed':
        return changedFiles(byKey.get(change.key)!.base, byKey.get(change.key)!.folder);
      case 'removed':
        return `removed · ${plural(folderFiles(byKey.get(change.key)?.base ?? byKey.get(change.key)!.folder).length, 'file')}`;
      case 'restored':
        return `files of task v${change.fromTaskVersion} from suite v${change.fromSuiteVersion}`;
      case 'label':
        return `suite.yaml label ${change.from ?? '—'} → ${change.to}`;
      case 'description':
        return 'suite.yaml description';
      case 'order':
        return 'suite.yaml task order';
    }
  };

  const writes: DraftWrite[] = [];
  const yamlNotes: string[] = [];
  const label = view.changes.find((c) => c.kind === 'label');
  if (label?.kind === 'label') yamlNotes.push(`version_label ${label.from ?? '—'} → ${label.to}`);
  const added = view.changes
    .filter((c) => c.kind === 'added')
    .map((c) => (c.kind === 'added' ? c.key : ''));
  const removedKeys: string[] = [];
  for (const t of tasks) {
    const taskRoot = `${root}/${t.row.key}`;
    if (t.row.state === 'removed' || (t.base !== null && t.base.key !== t.row.key)) {
      const gone = t.base ?? t.folder;
      writes.push({
        op: 'remove',
        path: `${root}/${gone.key}/`,
        beforeBytes: folderFiles(gone).reduce((n, f) => n + sizeOf(f), 0),
        afterBytes: null,
        note: plural(folderFiles(gone).length, 'file'),
      });
      removedKeys.push(gone.key);
    }
    if (t.row.state === 'removed' || t.row.state === 'unchanged') continue;
    writes.push(
      ...fileWrites(
        taskRoot,
        t.base !== null && t.base.key === t.row.key ? t.base : null,
        t.folder,
      ),
    );
  }
  if (added.length > 0) yamlNotes.push(`tasks + ${added.join(', ')}`);
  if (removedKeys.length > 0) yamlNotes.push(`tasks − ${removedKeys.join(', ')}`);
  if (
    isNew ||
    yamlNotes.length > 0 ||
    view.changes.some((c) => c.kind === 'order' || c.kind === 'description')
  ) {
    writes.unshift({
      op: isNew ? 'add' : 'change',
      path: `${root}/suite.yaml`,
      beforeBytes: null,
      afterBytes: null,
      note: yamlNotes.join(' · ') || null,
    });
  }

  const touched = tasks.filter(
    (t) => t.row.state === 'added' || t.row.state === 'changed' || t.row.state === 'restored',
  );
  const live = tasks.filter((t) => t.row.state !== 'removed');
  return {
    draft: view,
    changes: view.changes.map((change) => ({ change, detail: detail(change) })),
    writes,
    readiness: touched.map((t) => ({
      key: t.row.key,
      state: t.row.state,
      readiness: t.row.readiness?.summary ?? 'not_run',
      note: readinessNote(t.row.readiness),
    })),
    invalid: live.flatMap((t) => {
      const [first] = loaderProblems(t.row);
      return first === undefined ? [] : [{ key: t.row.key, reason: invalidReason(first) }];
    }),
  };
}
