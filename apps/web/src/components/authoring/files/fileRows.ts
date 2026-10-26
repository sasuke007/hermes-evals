/**
 * How the task editor lists files (Components 5, TaskFileTree; SA.6): the path a file has
 * where it is used (`/workspace/invoices.csv`, `~/memories/USER.md`), its folder for the
 * "▾ /workspace/docs/" rows, what each kind says in the Files tab ("as task.txt", "checks
 * only", "runs in the worker"), the actions a kind allows, and the folder's total.
 */
import type { DraftFileView, DraftFileViewKind, DraftUploadKind } from '@/api/types/authoring';
import { formatBytes, plural } from '@/lib/format';

/** The folder of a kind in the task folder: `fixtures`, `home`, the expected folders. */
export function kindFolder(
  kind: DraftUploadKind,
  expectedWorkspace: string | null,
  expectedHome: string | null,
): string {
  if (kind === 'fixture') return 'fixtures';
  if (kind === 'home_seed') return 'home';
  if (kind === 'expected') return expectedWorkspace ?? 'expected';
  return expectedHome ?? 'expected_home';
}

/** A file's path inside its kind's folder: `docs/payment-terms.pdf`. */
export function insideFolder(path: string, folder: string): string {
  return path.startsWith(`${folder}/`) ? path.slice(folder.length + 1) : path;
}

/** Where the file is when it is used: the agent's path, or the expected one. */
export function usePath(file: DraftFileView, folder: string): string {
  if (file.agentPath) return file.agentPath;
  const inner = insideFolder(file.path, folder);
  return file.kind === 'expected_home' ? `~/${inner}` : `/workspace/${inner}`;
}

export interface TreeRow {
  kind: 'folder' | 'file';
  /** The shown path; a folder row's ends in `/`. */
  label: string;
  file: DraftFileView | null;
  nested: boolean;
}

/** Files in path order, with a folder row before the files of each subfolder. */
export function treeRows(files: DraftFileView[], folder: string): TreeRow[] {
  const rows: TreeRow[] = [];
  const sorted = [...files].sort((a, b) => usePath(a, folder).localeCompare(usePath(b, folder)));
  let current: string | null = null;
  for (const file of sorted) {
    const shown = usePath(file, folder);
    const inner = insideFolder(file.path, folder);
    const dir = inner.includes('/') ? shown.slice(0, shown.lastIndexOf('/') + 1) : null;
    if (dir && dir !== current)
      rows.push({ kind: 'folder', label: dir, file: null, nested: false });
    current = dir;
    rows.push({ kind: 'file', label: shown, file, nested: dir !== null });
  }
  return rows;
}

const PREVIEWABLE = /\.(csv|tsv)$/i;
export const isPreviewable = (path: string): boolean => PREVIEWABLE.test(path);

export type FileAction =
  | 'Preview'
  | 'Replace'
  | 'Rename'
  | 'Delete'
  | 'Edit in form'
  | 'Open task.yaml tab'
  | 'View'
  | 'Copy path';

/** The actions of a row in the Files tab, by kind (SA.6). */
export function folderActions(file: DraftFileView): FileAction[] {
  switch (file.kind) {
    case 'prompt':
    case 'reference':
    case 'rubric':
      return ['Edit in form'];
    case 'task_yaml':
      return ['Open task.yaml tab'];
    case 'fixture':
    case 'home_seed':
      return isPreviewable(file.path)
        ? ['Preview', 'Replace', 'Rename', 'Delete']
        : ['Replace', 'Rename', 'Delete'];
    case 'expected':
    case 'expected_home':
      return isPreviewable(file.path) ? ['Preview', 'Replace', 'Delete'] : ['Replace', 'Delete'];
    case 'verifier':
      return ['View', 'Copy path'];
    default:
      return ['Copy path'];
  }
}

/** What the Files tab says after a row's chip. */
export function folderDetail(file: DraftFileView): string {
  const details: Partial<Record<DraftFileViewKind, string>> = {
    prompt: 'as task.txt',
    reference: 'checks only',
    expected: 'self-check only',
    expected_home: 'self-check only',
    rubric: 'judge only',
    verifier: 'runs in the worker',
    other: 'Not used by the platform · kept as is',
  };
  if (file.kind === 'fixture' || file.kind === 'home_seed') return file.agentPath ?? '';
  return details[file.kind] ?? '';
}

/** "7 files · 7.1 KB". */
export function folderTotal(files: DraftFileView[]): string {
  const bytes = files.reduce((sum, f) => sum + f.sizeBytes, 0);
  return `${plural(files.length, 'file')} · ${formatBytes(bytes)}`;
}

/** Files under the workspace's docs/ can collide with configuration documents (SA.5). */
export const collidesWithDocs = (file: DraftFileView): boolean =>
  file.kind === 'fixture' && file.path.startsWith('fixtures/docs/');
