/**
 * Which files of a task folder the loader reads, and what each one is
 * (plan 4.1, 3.1 task_files kinds):
 *
 * - `fixtures/**`: fixture, the only kind ever copied into a trial;
 * - the expected workspace folder (`self_check.expected_workspace`): expected;
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
import type { LoadIssue, TaskFileKind } from '@hermes-evals/shared';
import {
  FIXTURES_DIR,
  MAX_SUITE_FILE_BYTES,
  PROMPT_MD,
  REFERENCE_JSON,
  TASK_YAML,
  VERIFY_DIR,
} from './limits.js';
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

const under = (path: string, dir: string): boolean => path === dir || path.startsWith(`${dir}/`);

/** The kind of the file at `path`, or null when the loader does not read it. */
export function classify(path: string, layout: FileLayout): TaskFileKind | null {
  if (under(path, FIXTURES_DIR)) return path === FIXTURES_DIR ? null : 'fixture';
  if (layout.expectedDir !== null && under(path, layout.expectedDir)) {
    return path === layout.expectedDir ? null : 'expected';
  }
  if (layout.rubrics.includes(path)) return 'rubric';
  if (under(path, VERIFY_DIR)) return path === VERIFY_DIR ? null : 'verifier';
  return null;
}

/** Whether something at `path` matters to the task: a root file or inside a folder it reads. */
function isUsedLocation(path: string, layout: FileLayout): boolean {
  if (ROOT_FILES.has(path) || layout.rubrics.includes(path)) return true;
  const dirs = [FIXTURES_DIR, VERIFY_DIR, ...(layout.expectedDir ? [layout.expectedDir] : [])];
  return dirs.some((dir) => under(path, dir)) || dirs.some((dir) => dir.startsWith(`${path}/`));
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
  for (const entry of entries) {
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
