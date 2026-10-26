/**
 * Step 2 of a save (plan 4.6): the folder the draft stands for, built in
 * SUITES_DIR/.draft-<id>/ (the loader skips dot names), where nothing reads
 * it until the save has judged it.
 *
 * Files the draft decides come from the draft; every other entry of the live
 * folder is copied untouched (content, mode and time; a link stays the link
 * it was). A file is the draft's to decide when the draft holds it or when
 * the base version stored it (so a fixture the draft removed or moved is not
 * brought back); anything else is the author's: a README, notes, hidden
 * files, a file the loader refused (a link, one over the size limit), a
 * folder no version recorded. Per task of the draft, removed ones left out:
 *
 * - `unchanged`: the live entry, copied as it is (a task folder, or the link
 *   or other entry the loader found where a folder should be);
 * - `changed`: the draft's texts and its fixture, expected, expected_home
 *   and home_seed files, then every entry of the base's live folder the
 *   draft does not decide: verify/ (which draft endpoints never write, R7)
 *   and the author's files. A text the draft holds no text for (a
 *   prompt.md that is not UTF-8) is the live file. A `verifier` or `other`
 *   file the draft lists that the live folder lacks comes from its blob;
 * - `restored` over a live folder: every file of the older version from the
 *   draft, verify/ and the root files included, then the author's files of
 *   the live folder, which no version stores;
 * - `added`, a restored task with no live folder, and every task of a new
 *   suite: everything from the draft, verify/ scripts included (a copy, a
 *   restored version or a confirmed zip; draft endpoints never write there).
 *
 * At the suite's root: suite.yaml as rendered (drafts/suite-yaml.ts, which
 * leaves the live file's bytes alone where nothing changed), and every other
 * entry of the live root copied, folders included, but the folders of the
 * draft's tasks and of the tasks it removed or renamed.
 */
import { chmod, cp, lstat, mkdir, readdir, readlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DraftFileKind, TaskFileKind } from '@hermes-evals/shared';
import type { BlobStore } from '../../storage/blob-store.js';
import { folderOf, type StoredDraft } from '../drafts/draft-store.js';
import {
  addDraftFiles,
  writeDraftTaskFolder,
  type DraftTaskFolder,
  type MaterialisedFile,
} from '../drafts/materialise.js';
import { PROMPT_MD, REFERENCE_JSON, SUITE_YAML, TASK_YAML } from '../loader/limits.js';
import type { SuitesDir } from './suites-dir.js';

/** The kinds an edited task's draft writes; its verifier and other files come from the live folder. */
const MANAGED_KINDS: ReadonlySet<DraftFileKind> = new Set([
  'fixture',
  'expected',
  'expected_home',
  'home_seed',
]);

/** A file the base version stored for a task (task_files). */
export interface BaseFile {
  path: string;
  kind: TaskFileKind;
}

export interface StageInput {
  dir: SuitesDir;
  /** The staging folder's name under SUITES_DIR, `.draft-<id>`. */
  staging: string;
  /** The live folder's name for a draft of a folder on disk; null for a new suite. */
  live: string | null;
  stored: StoredDraft;
  /** The base task's key of each draft task that has one, by draft task id. */
  baseKeys: ReadonlyMap<string, string>;
  /** The files the base version stored for each draft task that has a base task, by draft task id. */
  baseFiles: ReadonlyMap<string, readonly BaseFile[]>;
  /** suite.yaml as the save writes it. */
  suiteYaml: string;
  blobs: Pick<BlobStore, 'path' | 'read' | 'stream'>;
}

/** Copies untouched: content, mode and times, links as the links they are, special files left out. */
const COPY = {
  recursive: true,
  errorOnExist: true,
  force: false,
  preserveTimestamps: true,
  verbatimSymlinks: true,
  filter: async (source: string) => {
    const entry = await lstat(source);
    return entry.isFile() || entry.isDirectory() || entry.isSymbolicLink();
  },
} as const;

/** Builds the staging folder; throws on any failure, leaving its removal to the caller. */
export async function buildStaging(input: StageInput): Promise<void> {
  const { dir } = input;
  const root = dir.folder(input.staging);
  const live = input.live === null ? null : dir.folder(input.live);
  await dir.remove(input.staging);
  await mkdir(root, { mode: 0o755 });
  await writeFile(dir.inside(join(root, SUITE_YAML)), input.suiteYaml, { flag: 'wx', mode: 0o644 });

  if (live !== null) {
    await chmod(root, (await lstat(live)).mode & 0o7777);
    // The draft decides its tasks' folders and those of the tasks it removed or renamed.
    const decided = new Set([SUITE_YAML]);
    for (const task of input.stored.tasks) {
      decided.add(task.key);
      const baseKey = input.baseKeys.get(task.id);
      if (baseKey !== undefined) decided.add(baseKey);
    }
    for (const entry of await readdir(live, { withFileTypes: true })) {
      if (decided.has(entry.name)) continue;
      await cp(join(live, entry.name), dir.inside(join(root, entry.name)), COPY);
    }
  }

  for (const task of input.stored.tasks) {
    if (task.state === 'removed') continue;
    const target = dir.inside(join(root, task.key));
    const folder = folderOf(input.stored, task);
    const baseKey = input.baseKeys.get(task.id) ?? null;
    const liveTask = live !== null && baseKey !== null ? join(live, baseKey) : null;
    const entry = liveTask === null ? null : await lstat(liveTask).catch(() => null);
    if (liveTask === null || entry === null) {
      await writeDraftTaskFolder(folder, target, { blobs: input.blobs });
      continue;
    }
    if (task.state === 'unchanged') {
      await cp(liveTask, target, COPY);
      continue;
    }
    if (!entry.isDirectory()) {
      // An edit of a task the loader found no folder for: the draft's folder replaces the entry.
      await writeDraftTaskFolder(folder, target, { blobs: input.blobs });
      continue;
    }
    const restored = task.state === 'restored';
    const written = await writeDraftTaskFolder(folder, target, {
      blobs: input.blobs,
      ...(restored ? {} : { kinds: MANAGED_KINDS }),
    });
    await chmod(target, entry.mode & 0o7777);
    const managed = managedPaths(folder, written, input.baseFiles.get(task.id) ?? [], restored);
    await copyUnmanaged(dir, liveTask, target, '', managed);
    if (restored) continue;
    const missing = [];
    for (const ref of folder.files) {
      if (MANAGED_KINDS.has(ref.kind)) continue;
      if (!(await exists(join(target, ref.path)))) missing.push(ref);
    }
    await addDraftFiles(task.key, target, missing, input.blobs);
  }
}

/**
 * The files the draft decides in a task folder that has a live folder, so
 * the copy of the live folder leaves them out: every file it wrote, every
 * file it holds by blob and every file the base version stored, verify/
 * aside for an edited task (the live scripts are the draft's, which never
 * changes them); for a restored task, the root files too, since the older
 * version's are the ones it holds. Everything else is the author's.
 */
function managedPaths(
  folder: DraftTaskFolder,
  written: readonly MaterialisedFile[],
  base: readonly BaseFile[],
  restored: boolean,
): (path: string) => boolean {
  const paths = new Set([...written.map((f) => f.path), ...Object.keys(folder.rubrics)]);
  if (restored) for (const path of [TASK_YAML, PROMPT_MD, REFERENCE_JSON]) paths.add(path);
  for (const file of [...folder.files, ...base]) {
    if (restored || file.kind !== 'verifier') paths.add(file.path);
  }
  return (path) => paths.has(path);
}

/**
 * Copies every entry of the live task folder that the draft does not
 * decide, walking it with lstat: hidden names included, links copied as
 * links, special files (a FIFO) left out, as nothing could read them anyway.
 * Where the draft wrote a file of its own at a path, the draft's stays.
 */
async function copyUnmanaged(
  dir: SuitesDir,
  from: string,
  to: string,
  rel: string,
  managed: (path: string) => boolean,
): Promise<void> {
  const entries = await readdir(join(from, rel), { withFileTypes: true });
  // An empty folder of the author's is kept; one the draft emptied is not made again.
  if (entries.length === 0 && rel !== '' && !(await exists(join(to, rel)))) {
    await mkdir(dir.inside(join(to, rel)), { recursive: true, mode: 0o755 });
  }
  for (const entry of entries) {
    const path = rel === '' ? entry.name : `${rel}/${entry.name}`;
    if (managed(path)) continue;
    const target = dir.inside(join(to, path));
    const there = await lstat(target).catch(() => null);
    if (entry.isDirectory()) {
      if (there === null || there.isDirectory()) await copyUnmanaged(dir, from, to, path, managed);
    } else if ((entry.isFile() || entry.isSymbolicLink()) && there === null) {
      await mkdir(join(target, '..'), { recursive: true, mode: 0o755 });
      await cp(join(from, path), target, COPY);
    }
  }
}

async function exists(path: string): Promise<boolean> {
  return (await lstat(path).catch(() => null)) !== null;
}

/**
 * Every entry under `path`, with what an edit by hand changes (mode, size,
 * modification time, a link's target), sorted. The save lists the live
 * folder before staging and again before the swap: any difference, even in
 * a file no version stores, means an edit it did not stage, and it stops.
 */
export async function folderListing(path: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    for (const entry of await readdir(join(path, rel), { withFileTypes: true })) {
      const sub = rel === '' ? entry.name : `${rel}/${entry.name}`;
      const stats = await lstat(join(path, sub));
      const link = stats.isSymbolicLink() ? await readlink(join(path, sub)) : '';
      out.push([sub, stats.mode, stats.size, stats.mtimeMs, link].join('\0'));
      if (stats.isDirectory()) await walk(sub);
    }
  };
  await walk('');
  return out.sort();
}
