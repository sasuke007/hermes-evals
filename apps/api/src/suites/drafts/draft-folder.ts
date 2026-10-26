/**
 * A draft task as the folder it stands for (plan 4.6), without touching the
 * disk:
 *
 * - draftFileKind: what a file of the folder is, from its path and the
 *   folders task.yaml names, as the loader classifies it (task-files.ts);
 * - folderReader: the folder's entries and a TaskReader over the draft's
 *   texts and blobs, so the loader's own analysis (analyseTask) judges the
 *   draft exactly as a reload would judge the same files on disk;
 * - baseTaskFolder: a stored task version as a draft folder, from its rows
 *   and blobs, byte for byte: the root files' recorded text when the loader
 *   kept it (task_root_files), else the texts on the task row, with each
 *   candidate checked against the version's content hash.
 */
import {
  HOME_MEMORIES_DIR,
  isHomeSeedPath,
  TASK_HOME_DIR,
  type DraftFileKind,
  type JsonValue,
} from '@hermes-evals/shared';
import { parseDocument } from 'yaml';
import { contentHash, sha256Hex, type HashedFile } from '../loader/hashing.js';
import {
  FIXTURES_DIR,
  PROMPT_MD,
  REFERENCE_JSON,
  SUITE_WALK_LIMITS,
  TASK_YAML,
  VERIFY_DIR,
} from '../loader/limits.js';
import { normaliseRelative, under, type TaskReader } from '../loader/task-files.js';
import { comparePaths, type SuiteEntry } from '../loader/walk.js';
import type { TaskFileRow, TaskRootFileRow, TaskRow } from '../views/rows.js';
import type { DraftFileRef, DraftTaskFolder } from './materialise.js';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The folders task.yaml names, normalised, as far as it parses. */
export interface DraftLayout {
  expectedDir: string | null;
  expectedHomeDir: string | null;
  /** Rubric paths of the llm_judge checks. */
  rubrics: string[];
}

export function layoutOf(taskYaml: string | null): DraftLayout {
  const empty: DraftLayout = { expectedDir: null, expectedHomeDir: null, rubrics: [] };
  if (taskYaml === null) return empty;
  const doc = parseDocument(taskYaml);
  if (doc.errors.length > 0) return empty;
  const raw: unknown = doc.toJS();
  if (!isRecord(raw)) return empty;
  const selfCheck = isRecord(raw.self_check) ? raw.self_check : {};
  const folder = (value: unknown) => (typeof value === 'string' ? normaliseRelative(value) : null);
  const rubrics: string[] = [];
  for (const entry of Array.isArray(raw.verification) ? raw.verification : []) {
    if (!isRecord(entry) || entry.type !== 'llm_judge' || !isRecord(entry.params)) continue;
    const rubric = folder(entry.params.rubric);
    if (rubric !== null) rubrics.push(rubric);
  }
  return {
    expectedDir: folder(selfCheck.expected_workspace),
    expectedHomeDir: folder(selfCheck.expected_home),
    rubrics,
  };
}

/**
 * The kind of a draft file at `path`: `verifier` under verify/, `fixture`
 * under fixtures/, `home_seed` for the two memory files, `expected` and
 * `expected_home` under the folders task.yaml names, `other` for anything
 * the loader does not read (kept as is).
 */
export function draftFileKind(path: string, layout: DraftLayout): DraftFileKind {
  if (under(path, VERIFY_DIR)) return 'verifier';
  if (under(path, FIXTURES_DIR)) return 'fixture';
  if (isHomeSeedPath(path)) return 'home_seed';
  if (under(path, TASK_HOME_DIR)) return 'other';
  if (layout.expectedDir !== null && under(path, layout.expectedDir)) return 'expected';
  if (
    layout.expectedHomeDir !== null &&
    path.startsWith(`${layout.expectedHomeDir}/${HOME_MEMORIES_DIR}/`)
  ) {
    return 'expected_home';
  }
  return 'other';
}

/** One file of the folder: a text the draft holds, or a blob. */
export type FolderFile =
  { path: string; text: string; ref: null } | { path: string; text: null; ref: DraftFileRef };

/** Every file of the folder, by path: task.yaml, prompt.md, reference.json, rubrics and blob files. */
export function folderFiles(task: DraftTaskFolder): FolderFile[] {
  const out: FolderFile[] = [];
  const texts: [string, string | null][] = [
    [TASK_YAML, task.taskYaml],
    [PROMPT_MD, task.prompt],
    [REFERENCE_JSON, task.reference],
    ...Object.entries(task.rubrics),
  ];
  const seen = new Set<string>();
  for (const [path, text] of texts) {
    if (text === null || seen.has(path)) continue;
    seen.add(path);
    out.push({ path, text, ref: null });
  }
  for (const ref of task.files) {
    if (seen.has(ref.path)) continue;
    seen.add(ref.path);
    out.push({ path: ref.path, text: null, ref });
  }
  return out.sort((a, b) => comparePaths(a.path, b.path));
}

export const utf8Size = (text: string): number => Buffer.byteLength(text, 'utf8');

/**
 * The folder as the loader's walk would list it (files and the folders
 * holding them, sorted by path; a folder nested deeper than the walk enters
 * is listed but not entered, and its files not listed), and a reader over
 * the draft's texts and blobs. Blob bytes come from `readBlob` by hash.
 */
export function folderReader(
  task: DraftTaskFolder,
  readBlob: (sha256: string) => Promise<Buffer>,
): { entries: SuiteEntry[]; read: TaskReader } {
  const files = folderFiles(task);
  const dirs = new Map<string, number>();
  const entries: SuiteEntry[] = [];
  for (const file of files) {
    const segments = file.path.split('/');
    // The task folder is depth 1 under the suite, as in the walk.
    let deep = false;
    for (let i = 1; i < segments.length; i++) {
      const dir = segments.slice(0, i).join('/');
      if (!dirs.has(dir) && i + 1 <= SUITE_WALK_LIMITS.maxDepth) dirs.set(dir, i + 1);
      if (i + 1 >= SUITE_WALK_LIMITS.maxDepth) deep = true;
    }
    if (deep) continue;
    entries.push({
      path: file.path,
      kind: 'file',
      size: file.text !== null ? utf8Size(file.text) : file.ref.size,
    });
  }
  for (const [path, depth] of dirs) {
    entries.push({ path, kind: 'dir', entered: depth < SUITE_WALK_LIMITS.maxDepth });
  }
  entries.sort((a, b) => comparePaths(a.path, b.path));
  const byPath = new Map(files.map((f) => [f.path, f]));
  const read: TaskReader = async (relPath) => {
    const file = byPath.get(relPath);
    if (!file) return { ok: false, reason: `${relPath} is not in the draft` };
    if (file.text !== null) {
      const content = Buffer.from(file.text, 'utf8');
      return { ok: true, content, sha256: sha256Hex(content) };
    }
    try {
      return { ok: true, content: await readBlob(file.ref.sha256), sha256: file.ref.sha256 };
    } catch (err) {
      return { ok: false, reason: `the stored file could not be read (${(err as Error).message})` };
    }
  };
  return { entries, read };
}

// ---------------------------------------------------------------------------
// A stored task version as a draft folder
// ---------------------------------------------------------------------------

const BOM = '﻿';

/** reference.json texts that parse to `value`, most likely first (the sample suites write 2-space JSON). */
function referenceCandidates(value: JsonValue): string[] {
  const forms = [
    JSON.stringify(value, null, 2),
    JSON.stringify(value),
    JSON.stringify(value, null, 4),
    JSON.stringify(value, null, '\t'),
  ];
  return [...new Set(forms.flatMap((f) => [`${f}\n`, f, `${f}\r\n`]))];
}

/** A text and the same text with a byte-order mark, which the task row's decoding dropped. */
const withBom = (text: string): string[] => (text.startsWith(BOM) ? [text] : [text, BOM + text]);

export interface BaseFolder {
  folder: DraftTaskFolder;
  /**
   * Whether the folder hashes to the version's content hash, so it is
   * byte for byte the files the version was loaded from. False only for a
   * version loaded before Phase 5b whose reference.json was formatted some
   * way the candidates do not reproduce: the draft then holds the same JSON
   * written in the canonical style.
   */
  exact: boolean;
}

/**
 * A task version as a draft folder: its root texts (the loader's recorded
 * text, else the task row's), each rubric as text (UTF-8, byte-order mark
 * kept), every other task file by blob with its draft kind. Without recorded
 * texts, each combination of candidates is hashed until one gives the
 * version's content hash.
 */
export async function baseTaskFolder(
  task: Pick<TaskRow, 'key' | 'taskYaml' | 'prompt' | 'reference' | 'contentHash'>,
  files: readonly Pick<TaskFileRow, 'path' | 'kind' | 'sha256' | 'size'>[],
  roots: readonly Pick<TaskRootFileRow, 'path' | 'sha256' | 'text'>[],
  readBlob: (sha256: string) => Promise<Buffer>,
): Promise<BaseFolder> {
  const rubrics: Record<string, string> = {};
  const refs: DraftFileRef[] = [];
  const layout = layoutOf(roots.find((r) => r.path === TASK_YAML)?.text ?? task.taskYaml);
  for (const file of files) {
    if (file.kind === 'rubric') {
      const bytes = await readBlob(file.sha256);
      const text = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true }).decode(bytes);
      if (Buffer.from(text, 'utf8').equals(bytes)) {
        rubrics[file.path] = text;
        continue;
      }
    }
    refs.push({
      path: file.path,
      kind: draftFileKind(file.path, layout),
      sha256: file.sha256,
      size: file.size,
    });
  }
  const fileHashes: HashedFile[] = files.map((f) => ({ path: f.path, sha256: f.sha256 }));
  const recorded = (path: string) => roots.find((r) => r.path === path);
  const options = (path: string, fallback: string[]): (string | null)[] => {
    const root = recorded(path);
    if (root?.text !== null && root?.text !== undefined) return [root.text];
    return fallback.length > 0 ? fallback : [null];
  };
  const yamls = options(TASK_YAML, task.taskYaml === null ? [] : withBom(task.taskYaml));
  const prompts = options(PROMPT_MD, task.prompt === null ? [] : withBom(task.prompt));
  const references = options(
    REFERENCE_JSON,
    task.reference === null ? [] : referenceCandidates(task.reference),
  );
  const hashOf = (taskYaml: string | null, prompt: string | null, reference: string | null) => {
    const hashed = [...fileHashes];
    for (const [path, text] of [
      [TASK_YAML, taskYaml],
      [PROMPT_MD, prompt],
      [REFERENCE_JSON, reference],
    ] as const) {
      if (text !== null && !hashed.some((h) => h.path === path))
        hashed.push({ path, sha256: sha256Hex(Buffer.from(text, 'utf8')) });
    }
    return contentHash(hashed);
  };
  const folder = (
    taskYaml: string | null,
    prompt: string | null,
    reference: string | null,
  ): DraftTaskFolder => ({
    key: task.key,
    taskYaml,
    prompt,
    reference,
    rubrics,
    files: refs.sort((a, b) => comparePaths(a.path, b.path)),
  });
  for (const y of yamls) {
    for (const p of prompts) {
      for (const r of references) {
        if (hashOf(y, p, r) === task.contentHash) return { folder: folder(y, p, r), exact: true };
      }
    }
  }
  return { folder: folder(yamls[0]!, prompts[0]!, references[0]!), exact: false };
}
