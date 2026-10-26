/**
 * A draft task as a folder (plan 4.6). The draft holds the text files the
 * forms edit verbatim and every other file by blob; this module turns that
 * picture into real files, for the two worker jobs that need them:
 *
 * - `self-check-draft` writes one task into a scratch directory under
 *   DATA_DIR/tmp and runs the loader's own task self-check on it
 *   (task-self-check.ts), so a draft is judged exactly as a reload would;
 * - `save-suite-draft` writes every task the draft manages into the staging
 *   folder SUITES_DIR/.draft-<id>/ (the loader skips dot names), next to the
 *   files it does not manage, which it copies from the live folder untouched.
 *
 * DraftTaskFolder is also what the readiness rules analyse (readiness.ts)
 * and what the imports produce (../import/parsers.ts), so a task looks the
 * same from its first upload to its save.
 */
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { lstat, mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { DraftFileKind } from '@hermes-evals/shared';
import type { suiteDraftFiles, suiteDraftTasks } from '../../database/schema/index.js';
import type { BlobStore } from '../../storage/blob-store.js';
import { sha256Hex } from '../loader/hashing.js';
import { PROMPT_MD, REFERENCE_JSON, TASK_YAML } from '../loader/limits.js';
import { comparePaths } from '../loader/walk.js';

/** A file of a draft task held by blob: what suite_draft_files stores. */
export interface DraftFileRef {
  /** Relative to the task folder, e.g. `fixtures/invoices.csv`; never absolute, never with `..`. */
  path: string;
  kind: DraftFileKind;
  sha256: string;
  size: number;
}

/** One draft task as the files it will be on disk. */
export interface DraftTaskFolder {
  /** The task's folder name. */
  key: string;
  /** task.yaml, prompt.md and reference.json verbatim; null when the folder has no such file. */
  taskYaml: string | null;
  prompt: string | null;
  reference: string | null;
  /** The rubric files llm_judge checks name, path in the task folder → text. */
  rubrics: Readonly<Record<string, string>>;
  /** Every other file, by path order. */
  files: readonly DraftFileRef[];
}

type DraftTaskRow = Pick<
  typeof suiteDraftTasks.$inferSelect,
  'key' | 'taskYaml' | 'prompt' | 'reference' | 'rubrics'
>;
type DraftFileRow = Pick<typeof suiteDraftFiles.$inferSelect, 'path' | 'kind' | 'sha256' | 'size'>;

/** The folder a stored draft task stands for: its row and its file rows. */
export function draftTaskFolderOf(
  task: DraftTaskRow,
  files: readonly DraftFileRow[],
): DraftTaskFolder {
  return {
    key: task.key,
    taskYaml: task.taskYaml,
    prompt: task.prompt,
    reference: task.reference,
    rubrics: task.rubrics,
    files: [...files]
      .map(({ path, kind, sha256, size }) => ({ path, kind, sha256, size }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  };
}

export interface MaterialiseOptions {
  /** Where the blob files' bytes come from. */
  blobs: Pick<BlobStore, 'path' | 'read' | 'stream'>;
  /**
   * The kinds of blob file to write; every kind when absent. The save of a
   * folder that exists on disk leaves out `verifier` and `other`, which it
   * copies from the live folder untouched (plan 4.6 step 2); a new suite has
   * no live folder, so its save writes them all. Text files are always
   * written.
   */
  kinds?: ReadonlySet<DraftFileKind>;
}

/** A file written, as hashed while it was written. */
export interface MaterialisedFile {
  path: string;
  sha256: string;
  size: number;
}

/**
 * Writes `task` into `dir`, which must not exist yet and is created with the
 * folders the files need (0755, files 0644, the worker's uid):
 *
 * - task.yaml, prompt.md and reference.json exactly as stored, as UTF-8
 *   (a null text writes no file), and each rubric at its path;
 * - each blob file of `options.kinds` at its path, copied from the blob
 *   store and hashed as it is copied; a hash that differs from the
 *   reference throws, since the store promised those bytes.
 *
 * Every path is checked again before it is used: no absolute path, no `.`
 * or `..` segment, no backslash, nothing that resolves outside `dir`, and
 * never through a link (files are created with O_EXCL). Returns every file
 * written, sorted by path. Throws on any failure and leaves cleanup to the
 * caller, which owns `dir` (a scratch directory, or the staging folder it
 * removes when the save fails).
 */
export async function writeDraftTaskFolder(
  task: DraftTaskFolder,
  dir: string,
  options: MaterialiseOptions,
): Promise<MaterialisedFile[]> {
  const root = resolve(dir);
  const texts: Array<[string, string]> = [];
  if (task.taskYaml !== null) texts.push([TASK_YAML, task.taskYaml]);
  if (task.prompt !== null) texts.push([PROMPT_MD, task.prompt]);
  if (task.reference !== null) texts.push([REFERENCE_JSON, task.reference]);
  texts.push(...Object.entries(task.rubrics));
  const blobFiles = task.files.filter((f) => options.kinds?.has(f.kind) ?? true);

  // Every path is checked before anything is written, so a bad one leaves nothing half done.
  const seen = new Set<string>();
  for (const path of [...texts.map(([p]) => p), ...blobFiles.map((f) => f.path)]) {
    targetOf(root, path);
    if (seen.has(path)) throw new Error(`${task.key}: ${JSON.stringify(path)} is written twice`);
    seen.add(path);
  }

  await mkdir(root, { mode: 0o755 });
  const written: MaterialisedFile[] = [];
  for (const [path, text] of texts) {
    const bytes = Buffer.from(text, 'utf8');
    const target = await parentReady(root, path);
    await writeFile(target, bytes, { flag: 'wx', mode: 0o644 });
    written.push({ path, sha256: sha256Hex(bytes), size: bytes.length });
  }
  written.push(...(await writeBlobs(task.key, root, blobFiles, options.blobs)));
  return written.sort((a, b) => comparePaths(a.path, b.path));
}

/**
 * Adds blob files to a task folder that exists, under the same checks: the
 * save uses it for a draft's `verifier` and `other` files that the live
 * folder it copied from does not hold. A path that exists is refused (O_EXCL).
 */
export async function addDraftFiles(
  key: string,
  dir: string,
  files: readonly DraftFileRef[],
  blobs: MaterialiseOptions['blobs'],
): Promise<MaterialisedFile[]> {
  const root = resolve(dir);
  for (const file of files) targetOf(root, file.path);
  return writeBlobs(key, root, files, blobs);
}

async function writeBlobs(
  key: string,
  root: string,
  files: readonly DraftFileRef[],
  blobs: MaterialiseOptions['blobs'],
): Promise<MaterialisedFile[]> {
  const written: MaterialisedFile[] = [];
  for (const file of files) {
    const target = await parentReady(root, file.path);
    const copied = await copyBlob(blobs, file.sha256, target);
    if (copied.sha256 !== file.sha256 || copied.size !== file.size) {
      throw new Error(
        `${key}/${file.path}: the blob store's bytes do not match the draft (${copied.sha256.slice(0, 7)}, ${copied.size} bytes)`,
      );
    }
    written.push({ path: file.path, ...copied });
  }
  return written;
}

/** The absolute path of `path` in `root`; throws for anything but a plain relative path inside it. */
function targetOf(root: string, path: string): string {
  const segments = path.split('/');
  if (
    path === '' ||
    path.includes('\\') ||
    path.includes('\0') ||
    isAbsolute(path) ||
    segments.some((s) => s === '' || s === '.' || s === '..')
  ) {
    throw new Error(`refusing to write ${JSON.stringify(path)}: not a relative path in the task`);
  }
  const target = resolve(root, path);
  if (!target.startsWith(`${root}${sep}`)) {
    throw new Error(`refusing to write ${JSON.stringify(path)}: it resolves outside the task`);
  }
  return target;
}

/**
 * Creates the folders above `path`, refusing to pass through anything that
 * is not a real folder (a link, a file), and returns the file's path.
 */
async function parentReady(root: string, path: string): Promise<string> {
  const target = targetOf(root, path);
  let at = root;
  for (const segment of path.split('/').slice(0, -1)) {
    at = join(at, segment);
    const entry = await lstat(at).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return null;
      throw err;
    });
    if (entry === null) await mkdir(at, { mode: 0o755 });
    else if (!entry.isDirectory()) {
      throw new Error(`refusing to write ${JSON.stringify(path)}: ${segment} is not a folder`);
    }
  }
  return target;
}

/** Copies one blob to a new file (O_EXCL), hashing the bytes as they pass. */
async function copyBlob(
  blobs: MaterialiseOptions['blobs'],
  sha256: string,
  target: string,
): Promise<{ sha256: string; size: number }> {
  const hash = createHash('sha256');
  let size = 0;
  await pipeline(
    blobs.stream(sha256),
    async function* (chunks: AsyncIterable<Buffer>) {
      for await (const chunk of chunks) {
        hash.update(chunk);
        size += chunk.length;
        yield chunk;
      }
    },
    createWriteStream(target, { flags: 'wx', mode: 0o644 }),
  );
  return { sha256: hash.digest('hex'), size };
}
