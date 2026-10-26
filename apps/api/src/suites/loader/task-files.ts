/**
 * Which files of a task folder the loader reads, and what each one is
 * (plan 4.1, 3.1 task_files kinds):
 *
 * - `fixtures/**`: fixture, copied into the trial's workspace;
 * - `home/memories/MEMORY.md` and `home/memories/USER.md`: home_seed, copied
 *   into the trial's home (Phase 6 P1). Nothing else may be under `home/`:
 *   any other path there is a `home_path_invalid` error;
 * - the expected workspace folder (`self_check.expected_workspace`): expected;
 * - the expected home folder (`self_check.expected_home`): expected_home,
 *   whose files mirror the home and so must be under its `memories/`;
 * - files an llm_judge entry names as its rubric: rubric;
 * - `verify/**`: verifier.
 *
 * task.yaml, prompt.md and reference.json are stored on the task row instead.
 * Anything else in the folder (a README, notes) is neither read nor hashed,
 * so editing it creates no new version. A link, special file, unreadable or
 * oversized file where the task needs files is an error (the task is
 * invalid); elsewhere it is a warning, since nothing would read it anyway.
 */
import { posix } from 'node:path';
import {
  HOME_MEMORIES_DIR,
  isHomeSeedPath,
  TASK_HOME_DIR,
  type LoadIssue,
  type TaskFileKind,
} from '@hermes-evals/shared';
import {
  FIXTURES_DIR,
  MAX_SUITE_FILE_BYTES,
  PROMPT_MD,
  REFERENCE_JSON,
  TASK_YAML,
  VERIFY_DIR,
} from './limits.js';
import { homePathMessage } from './messages.js';
import type { SuiteEntry } from './walk.js';

export type ReadResult =
  { ok: true; content: Buffer; sha256: string } | { ok: false; reason: string };

/** Reads one regular file of the task folder, never through a link. Paths are relative to the folder. */
export type TaskReader = (relPath: string) => Promise<ReadResult>;

export interface StoredTaskFile {
  /** Relative to the task folder, e.g. `fixtures/invoices.csv`. */
  path: string;
  kind: TaskFileKind;
  content: Buffer;
  sha256: string;
  size: number;
}

/** What task.yaml says about where files are, as far as it could be read. */
export interface FileLayout {
  /** Normalised expected workspace folder, e.g. `expected`, or null. */
  expectedDir: string | null;
  /** Normalised expected home folder, e.g. `expected_home`, or null (Phase 6 P2). */
  expectedHomeDir: string | null;
  /** Normalised rubric paths of the llm_judge entries. */
  rubrics: readonly string[];
}

export const ROOT_FILES: ReadonlySet<string> = new Set([TASK_YAML, PROMPT_MD, REFERENCE_JSON]);

/** `./a//b/` → `a/b`; null when nothing is left or the path escapes. */
export function normaliseRelative(path: string): string | null {
  const normal = posix.normalize(path).replace(/\/+$/, '');
  if (
    normal === '' ||
    normal === '.' ||
    normal.startsWith('/') ||
    normal.split('/').includes('..')
  ) {
    return null;
  }
  return normal;
}

export const under = (path: string, dir: string): boolean =>
  path === dir || path.startsWith(`${dir}/`);

/** The seeds' folder in the task, `home/memories`: the only folder `home/` may hold. */
const HOME_SEED_DIR = `${TASK_HOME_DIR}/${HOME_MEMORIES_DIR}`;

/**
 * The kind of the file at `path`, or null when the loader does not read it.
 * Under `home/`, only HOME_SEED_PATHS are read (homePathIssue reports the
 * rest); under the expected home, only files below its `memories/`.
 */
export function classify(path: string, layout: FileLayout): TaskFileKind | null {
  if (under(path, FIXTURES_DIR)) return path === FIXTURES_DIR ? null : 'fixture';
  if (under(path, TASK_HOME_DIR)) return isHomeSeedPath(path) ? 'home_seed' : null;
  if (layout.expectedDir !== null && under(path, layout.expectedDir)) {
    return path === layout.expectedDir ? null : 'expected';
  }
  if (layout.expectedHomeDir !== null && under(path, layout.expectedHomeDir)) {
    return path.startsWith(`${layout.expectedHomeDir}/${HOME_MEMORIES_DIR}/`)
      ? 'expected_home'
      : null;
  }
  if (layout.rubrics.includes(path)) return 'rubric';
  if (under(path, VERIFY_DIR)) return path === VERIFY_DIR ? null : 'verifier';
  return null;
}

/** The folders whose files the task reads, as the layout places them. */
const usedDirs = (layout: FileLayout): string[] => [
  FIXTURES_DIR,
  VERIFY_DIR,
  TASK_HOME_DIR,
  ...(layout.expectedDir ? [layout.expectedDir] : []),
  ...(layout.expectedHomeDir ? [layout.expectedHomeDir] : []),
];

/** Whether something at `path` matters to the task: a root file or inside a folder it reads. */
function isUsedLocation(path: string, layout: FileLayout): boolean {
  if (ROOT_FILES.has(path) || layout.rubrics.includes(path)) return true;
  const dirs = usedDirs(layout);
  return dirs.some((dir) => under(path, dir)) || dirs.some((dir) => dir.startsWith(`${path}/`));
}

/**
 * Why `entry` may not be where it is, or null: under `home/`, anything but
 * the `memories/` folder and HOME_SEED_PATHS as regular files (Phase 6 P1);
 * under the expected home, any file outside its `memories/`, which no run
 * ever collects. Only the shallowest offending path is reported, so a stray
 * folder is one issue, not one per file in it.
 */
export function homePathIssue(
  entry: SuiteEntry,
  layout: FileLayout,
  reported: ReadonlySet<string>,
): LoadIssue | null {
  const parentReported = [...reported].some((p) => entry.path.startsWith(`${p}/`));
  if (parentReported) return null;
  if (under(entry.path, TASK_HOME_DIR) && entry.path !== TASK_HOME_DIR) {
    if (entry.path === HOME_SEED_DIR && entry.kind === 'dir') return null;
    if (isHomeSeedPath(entry.path) && entry.kind !== 'dir') return null;
    return {
      severity: 'error',
      code: 'home_path_invalid',
      path: entry.path,
      message: homePathMessage(entry.path, isHomeSeedPath(entry.path) ? 'seed_dir' : 'seed'),
    };
  }
  const home = layout.expectedHomeDir;
  if (home !== null && entry.kind !== 'dir' && entry.path.startsWith(`${home}/`)) {
    if (entry.path.startsWith(`${home}/${HOME_MEMORIES_DIR}/`)) return null;
    return {
      severity: 'error',
      code: 'home_path_invalid',
      path: entry.path,
      message: homePathMessage(entry.path, 'expected', home),
    };
  }
  return null;
}

const MIB = 1024 * 1024;

/** Why an entry that is not a readable regular file is never read. */
function unsafeReason(entry: SuiteEntry): string | null {
  switch (entry.kind) {
    case 'symlink':
      return `${entry.path} is a symbolic link; the loader never follows links`;
    case 'special':
      return `${entry.path} is a ${entry.type === 'unknown' ? 'special file' : entry.type}, not a regular file`;
    case 'unreadable':
      return `${entry.path} cannot be read (${entry.reason})`;
    case 'dir':
      return entry.entered ? null : `${entry.path} is nested too deep; its files are not read`;
    case 'file':
      return entry.size > MAX_SUITE_FILE_BYTES
        ? `${entry.path} is larger than ${MAX_SUITE_FILE_BYTES / MIB} MiB (${entry.size} bytes)`
        : null;
  }
}

/**
 * Reports every unsafe entry of the folder (error where the task reads files,
 * warning elsewhere) and reads every file the layout classifies. Root files
 * are left to the caller.
 */
export async function collectTaskFiles(
  entries: readonly SuiteEntry[],
  layout: FileLayout,
  read: TaskReader,
  issues: LoadIssue[],
): Promise<StoredTaskFile[]> {
  const files: StoredTaskFile[] = [];
  const misplaced = new Set<string>();
  for (const entry of entries) {
    const homeIssue = homePathIssue(entry, layout, misplaced);
    if (homeIssue !== null) {
      issues.push(homeIssue);
      misplaced.add(entry.path);
      continue;
    }
    if ([...misplaced].some((p) => entry.path.startsWith(`${p}/`))) continue;
    const used = isUsedLocation(entry.path, layout);
    const reason = unsafeReason(entry);
    if (reason !== null) {
      issues.push({
        severity: used ? 'error' : 'warning',
        code: 'unsafe_file',
        path: entry.path,
        message: used ? reason : `${reason}; it is not part of the task and is ignored`,
      });
      continue;
    }
    if (entry.kind !== 'file' || ROOT_FILES.has(entry.path)) continue;
    const kind = classify(entry.path, layout);
    if (kind === null) continue;
    const result = await read(entry.path);
    if (!result.ok) {
      issues.push({
        severity: 'error',
        code: 'unsafe_file',
        path: entry.path,
        message: `${entry.path} could not be read safely: ${result.reason}`,
      });
      continue;
    }
    files.push({
      path: entry.path,
      kind,
      content: result.content,
      sha256: result.sha256,
      size: result.content.length,
    });
  }
  return files;
}

/** Text of a file that must be UTF-8, or null. A byte-order mark is dropped. */
export function decodeUtf8(content: Buffer): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    return null;
  }
}
