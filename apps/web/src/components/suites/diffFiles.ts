/**
 * The Files table of a task diff (TaskDiff board): prompt.md, task.yaml and reference.json
 * first, as the board lists them, then the task files by path, each marked changed, added,
 * removed or unchanged with its size and hash. The API lists the root files with the sizes
 * and hashes the loader recorded (Phase 5b); a version loaded before has no record of its
 * reference.json, and the row then shows no size. Pure.
 */
import type { TaskFileChange, TextDiffLine } from '@/api/types/suites';
import { formatBytes, MISSING, plural, shortHash } from '@/lib/format';

export type FileChange = TaskFileChange['change'];

export interface FileRow {
  path: string;
  change: FileChange;
  size: string;
  /** The older hash of a changed file. */
  from: string | null;
  to: string | null;
}

/** The three files every task folder holds, in the board's order. */
export const ROOT_FILES = ['prompt.md', 'task.yaml', 'reference.json'] as const;

export interface DiffFilesInput {
  files: readonly TaskFileChange[];
  prompt: readonly TextDiffLine[];
  taskYaml: readonly TextDiffLine[];
  /** True when the reference answer changed (its JSON diff is not empty). */
  referenceChanged: boolean;
  /** Every file is new: a first version shown against itself, or a task new in a draft. */
  allAdded: boolean;
}

const textChanged = (lines: readonly TextDiffLine[]): boolean =>
  lines.some((l) => l.kind !== 'same');

function rowOf(f: TaskFileChange, allAdded: boolean): FileRow {
  const change: FileChange = allAdded ? 'added' : f.change;
  const before = f.before ? formatBytes(f.before.sizeBytes) : null;
  const after = f.after ? formatBytes(f.after.sizeBytes) : null;
  return {
    path: f.path,
    change,
    size: change === 'changed' ? `${before} → ${after}` : (after ?? before ?? MISSING),
    from: change === 'changed' && f.before ? shortHash(f.before.sha256) : null,
    to: f.after ? shortHash(f.after.sha256) : f.before ? shortHash(f.before.sha256) : null,
  };
}

/** The rows of the Files table. */
export function diffFileRows(input: DiffFilesInput): FileRow[] {
  const byPath = new Map(input.files.map((f) => [f.path, f]));
  const changed: Record<(typeof ROOT_FILES)[number], boolean> = {
    'prompt.md': textChanged(input.prompt),
    'task.yaml': textChanged(input.taskYaml),
    'reference.json': input.referenceChanged,
  };
  const roots = ROOT_FILES.map((path): FileRow => {
    const recorded = byPath.get(path);
    if (recorded) return rowOf(recorded, input.allAdded);
    // Not recorded (a version loaded before Phase 5b): the change from the text diffs, no size.
    const change: FileChange = input.allAdded ? 'added' : changed[path] ? 'changed' : 'unchanged';
    return { path, change, size: MISSING, from: null, to: null };
  });
  const rootSet = new Set<string>(ROOT_FILES);
  return [
    ...roots,
    ...input.files.filter((f) => !rootSet.has(f.path)).map((f) => rowOf(f, input.allAdded)),
  ];
}

/** "4 files changed · 1 unchanged", "4 files", "4 files added". */
export function fileCountLine(rows: readonly FileRow[], mode: 'diff' | 'listing' | 'new'): string {
  if (mode === 'listing') return plural(rows.length, 'file');
  if (mode === 'new') return `${plural(rows.length, 'file')} added`;
  const changedCount = rows.filter((r) => r.change !== 'unchanged').length;
  const unchanged = rows.length - changedCount;
  const head = `${plural(changedCount, 'file')} changed`;
  return unchanged > 0 ? `${head} · ${unchanged} unchanged` : head;
}
