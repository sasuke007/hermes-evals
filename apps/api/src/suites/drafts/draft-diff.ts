/**
 * A draft task against its base version (GET …/tasks/:key/diff; SA.11's
 * rows): prompt.md and task.yaml as line diffs, reference.json as changed
 * JSON paths and as text, every file of the folder with its size and hash,
 * and line diffs of the small text files that changed.
 */
import {
  AUTHORING_LIMITS,
  type DraftTaskDiff,
  type JsonValue,
  type TaskFileChange,
  type TaskTextFileDiff,
} from '@hermes-evals/shared';
import { sha256Hex } from '../loader/hashing.js';
import { PROMPT_MD, REFERENCE_JSON, TASK_YAML } from '../loader/limits.js';
import { decodeUtf8 } from '../loader/task-files.js';
import { jsonDiff, textDiff } from '../views/diffs.js';
import { isoTime } from '../views/format.js';
import { folderFiles, utf8Size, type FolderFile } from './draft-folder.js';
import type { DraftTaskDbRow, StoredTask } from './draft-store.js';
import type { DraftTaskFolder } from './materialise.js';

const ROOTS = [TASK_YAML, PROMPT_MD, REFERENCE_JSON];

interface Side {
  sizeBytes: number;
  sha256: string;
  file: FolderFile;
}

const sideOf = (file: FolderFile): Side =>
  file.text !== null
    ? { sizeBytes: utf8Size(file.text), sha256: sha256Hex(Buffer.from(file.text, 'utf8')), file }
    : { sizeBytes: file.ref.size, sha256: file.ref.sha256, file };

const parseJson = (text: string | null): JsonValue | undefined => {
  if (text === null) return undefined;
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    return undefined;
  }
};

export interface DraftDiffInput {
  task: DraftTaskDbRow;
  folder: DraftTaskFolder;
  base: StoredTask | null;
  baseFolder: DraftTaskFolder | null;
  read: (sha256: string) => Promise<Buffer>;
}

export async function draftTaskDiff(input: DraftDiffInput): Promise<DraftTaskDiff> {
  const { folder, baseFolder } = input;
  const before = new Map(
    (baseFolder ? folderFiles(baseFolder) : []).map((f) => [f.path, sideOf(f)]),
  );
  const after = new Map(folderFiles(folder).map((f) => [f.path, sideOf(f)]));
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort((a, b) => {
    const ra = ROOTS.indexOf(a);
    const rb = ROOTS.indexOf(b);
    if (ra >= 0 || rb >= 0) return (ra < 0 ? 9 : ra) - (rb < 0 ? 9 : rb);
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const files: TaskFileChange[] = paths.map((path) => {
    const b = before.get(path);
    const a = after.get(path);
    const version = (s: Side | undefined) =>
      s ? { sizeBytes: s.sizeBytes, sha256: s.sha256 } : null;
    return {
      path,
      change: !b ? 'added' : !a ? 'removed' : b.sha256 === a.sha256 ? 'unchanged' : 'changed',
      before: version(b),
      after: version(a),
    };
  });
  const textOf = async (side: Side): Promise<string | null> => {
    if (side.sizeBytes > AUTHORING_LIMITS.textFixtureDiffMaxBytes) return null;
    if (side.file.text !== null) return side.file.text;
    return decodeUtf8(await input.read(side.sha256).catch(() => Buffer.alloc(0)));
  };
  const textFiles: TaskTextFileDiff[] = [];
  for (const change of files) {
    if (change.change !== 'changed' || ROOTS.includes(change.path)) continue;
    const [b, a] = [before.get(change.path)!, after.get(change.path)!];
    const [bt, at] = [await textOf(b), await textOf(a)];
    if (bt !== null && at !== null) textFiles.push({ path: change.path, lines: textDiff(bt, at) });
  }
  const refBefore = parseJson(baseFolder?.reference ?? null);
  const refAfter = parseJson(folder.reference);
  return {
    key: folder.key,
    from: input.base
      ? {
          suiteId: input.base.suite.id,
          suiteVersion: input.base.suite.versionNumber,
          taskVersion: input.base.task.versionNumber,
        }
      : null,
    updatedAt: isoTime(input.task.updatedAt),
    prompt: textDiff(baseFolder?.prompt ?? null, folder.prompt),
    taskYaml: textDiff(baseFolder?.taskYaml ?? null, folder.taskYaml),
    reference:
      refBefore !== undefined && refAfter !== undefined ? jsonDiff(refBefore, refAfter) : [],
    referenceText: textDiff(baseFolder?.reference ?? null, folder.reference),
    files,
    textFiles,
  };
}
