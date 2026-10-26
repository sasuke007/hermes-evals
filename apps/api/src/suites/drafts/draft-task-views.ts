/**
 * One draft task as the task editor shows it (SA.4 to SA.6): its texts, the
 * form (or why it is locked), every file of the folder with what the agent
 * sees of it, its readiness and its last worker self-check.
 */
import {
  homeSeedTarget,
  isHomeSeedPath,
  type DraftFileView,
  type DraftFileViewKind,
  type DraftRef,
  type DraftTaskDetail,
  type TaskReadiness,
} from '@hermes-evals/shared';
import type { DraftSelfCheckRecord } from '../../database/schema/index.js';
import { sha256Hex } from '../loader/hashing.js';
import { PROMPT_MD, REFERENCE_JSON, TASK_YAML } from '../loader/limits.js';
import { isoTime } from '../views/format.js';
import { fixtureTypeLabel } from '../views/table.js';
import { folderFiles, utf8Size, type FolderFile } from './draft-folder.js';
import type { DraftTaskDbRow } from './draft-store.js';
import type { DraftTaskFolder } from './materialise.js';
import { selfCheckView } from './readiness-self-check.js';
import { formOf } from './task-form.js';

/** Files larger than this get a type label from their name alone. */
export const LABEL_READ_MAX_BYTES = 1024 * 1024;

const ROOT_KINDS: Record<string, DraftFileViewKind> = {
  [TASK_YAML]: 'task_yaml',
  [PROMPT_MD]: 'prompt',
  [REFERENCE_JSON]: 'reference',
};

/** What a file is, who sees it, and where the agent finds it. */
function placement(file: FolderFile): Pick<DraftFileView, 'kind' | 'visibility' | 'agentPath'> {
  if (file.ref === null) {
    const kind = ROOT_KINDS[file.path] ?? 'rubric';
    return kind === 'prompt'
      ? { kind, visibility: 'agent', agentPath: 'task.txt' }
      : { kind, visibility: 'hidden', agentPath: null };
  }
  const { kind, path } = file.ref;
  switch (kind) {
    case 'fixture':
      return {
        kind,
        visibility: 'agent',
        agentPath: `/workspace/${path.slice('fixtures/'.length)}`,
      };
    case 'home_seed':
      return {
        kind,
        visibility: 'agent',
        agentPath: isHomeSeedPath(path) ? `~/${homeSeedTarget(path)}` : null,
      };
    case 'other':
      return { kind, visibility: 'other', agentPath: null };
    default:
      return { kind, visibility: 'hidden', agentPath: null };
  }
}

/** The order of the Files tab: the text files the forms edit, then the rest by path. */
const rank = (file: FolderFile): number =>
  file.path === TASK_YAML
    ? 0
    : file.path === PROMPT_MD
      ? 1
      : file.path === REFERENCE_JSON
        ? 2
        : file.ref === null
          ? 3
          : 4;

/** Every file of the folder; blobs up to LABEL_READ_MAX_BYTES are read for their type label. */
export async function fileViews(
  folder: DraftTaskFolder,
  readBlob: (sha256: string) => Promise<Buffer>,
): Promise<DraftFileView[]> {
  const files = folderFiles(folder).sort((a, b) => rank(a) - rank(b));
  return Promise.all(
    files.map(async (file): Promise<DraftFileView> => {
      const bytes =
        file.text !== null
          ? Buffer.from(file.text, 'utf8')
          : file.ref.size <= LABEL_READ_MAX_BYTES
            ? await readBlob(file.ref.sha256).catch(() => null)
            : null;
      return {
        path: file.path,
        ...placement(file),
        sizeBytes: file.text !== null ? utf8Size(file.text) : file.ref.size,
        sha256: file.text !== null ? sha256Hex(bytes!) : file.ref.sha256,
        typeLabel: fixtureTypeLabel(file.path, bytes),
      };
    }),
  );
}

export interface TaskDetailInput {
  ref: DraftRef;
  task: DraftTaskDbRow;
  folder: DraftTaskFolder;
  files: DraftFileView[];
  base: DraftTaskDetail['base'];
  restoredFrom: DraftTaskDetail['restoredFrom'];
  /** The stored readiness; recomputed by the caller when absent. */
  readiness: TaskReadiness;
  /** The last worker self-check that applies: the draft's own, else the base's or the restored version's. */
  selfCheck: DraftSelfCheckRecord | null;
}

export function taskDetail(input: TaskDetailInput): DraftTaskDetail {
  const { task, folder } = input;
  const read = formOf(folder.taskYaml);
  return {
    draft: input.ref,
    key: task.key,
    position: task.position,
    state: task.state,
    base: input.base,
    restoredFrom: input.restoredFrom,
    taskYaml: folder.taskYaml,
    prompt: folder.prompt,
    reference: folder.reference,
    rubrics: Object.entries(folder.rubrics)
      .map(([path, text]) => ({ path, text }))
      .sort((a, b) => (a.path < b.path ? -1 : 1)),
    form: read.form,
    formLock: read.lock,
    files: input.files,
    readiness: input.readiness,
    selfCheck: selfCheckView(input.selfCheck, task.contentHash),
    revision: task.revision,
    updatedAt: isoTime(task.updatedAt),
  };
}
