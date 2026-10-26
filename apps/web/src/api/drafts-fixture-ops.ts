/**
 * What the draft endpoints do in fixtures mode, on the in-memory world of ./drafts-fixtures.ts:
 * the same refusals as the API where the editor reacts to them (a key that is not a folder
 * name or that another task holds, a write under verify/, a file over 25 MB, a self-check
 * with no worker), and the same answers otherwise. Review, save and rebase are in
 * ./drafts-fixture-save.ts.
 */
import {
  AUTHORING_LIMITS,
  DIRECTORY_KEY_MESSAGE,
  DIRECTORY_KEY_PATTERN,
  isVerifyPath,
} from '@hermes-evals/shared';
import type {
  CreateDraftTaskRequest,
  DraftFileUploadFields,
  DraftSelfCheckView,
  DraftTaskCreateResult,
  DraftTaskDetail,
  SuiteDraftView,
  TryCheckRequest,
  TryCheckResult,
  UpdateDraftTaskRequest,
  UpdateSuiteDraftRequest,
} from './types/authoring';
import { ApiError } from './client';
import { hasScenario } from './source';
import { fixtureSelfCheck, fixtureTry } from './drafts-fixture-score';
import {
  blankContent,
  fileView,
  kindOfPath,
  readTaskYaml,
  taskYamlOf,
  typeLabelOf,
} from './drafts-fixture-tasks';
import { draftView, taskDetailView, touch } from './drafts-fixture-views';
import {
  baseTask,
  draftWorld,
  makeTask,
  nowIso,
  suiteState,
  type FixtureDraft,
  type FixtureTask,
} from './drafts-fixtures';
import { SUITE_V1_ID, SUITE_V2_ID } from '@/fixtures/suites';

const draftPath = (folder: string) => `/api/suites/${folder}/draft`;

export function findDraft(folder: string, request: string): FixtureDraft {
  const draft = draftWorld().get(folder);
  if (!draft) throw new ApiError(404, request, `no draft of ${folder}`);
  return draft;
}

function findTask(folder: string, key: string, request: string): [FixtureDraft, FixtureTask] {
  const draft = findDraft(folder, request);
  const task = draft.tasks.find((t) => t.key === key);
  if (!task) throw new ApiError(404, request, `task ${key} is not in the draft of ${folder}`);
  return [draft, task];
}

/** Writes are refused while a save runs (SuiteDraftView.saving). */
function writable(draft: FixtureDraft, request: string): void {
  if (draft.saving)
    throw new ApiError(409, request, 'the draft is being saved; try again when it is done');
}

export function patchDraft(folder: string, body: UpdateSuiteDraftRequest): SuiteDraftView {
  const request = `PATCH ${draftPath(folder)}`;
  const draft = findDraft(folder, request);
  writable(draft, request);
  if (body.versionLabel !== undefined) draft.versionLabel = body.versionLabel;
  if (body.description !== undefined) draft.description = body.description;
  if (body.order) {
    body.order.forEach((key, i) => {
      const task = draft.tasks.find((t) => t.key === key);
      if (task) task.position = i;
    });
  }
  touch(draft);
  return draftView(draft);
}

/** A free key: `new_task`, then `new_task_2`, … */
function freeKey(draft: FixtureDraft, wanted: string): string {
  const taken = new Set(draft.tasks.map((t) => t.key));
  if (!taken.has(wanted)) return wanted;
  let n = 2;
  while (taken.has(`${wanted}_${n}`)) n++;
  return `${wanted}_${n}`;
}

function checkKey(draft: FixtureDraft, key: string, request: string, self?: FixtureTask): void {
  if (!DIRECTORY_KEY_PATTERN.test(key)) {
    throw new ApiError(400, request, DIRECTORY_KEY_MESSAGE, [
      { path: 'key', message: DIRECTORY_KEY_MESSAGE },
    ]);
  }
  if (draft.tasks.some((t) => t.key === key && t !== self)) {
    throw new ApiError(409, request, `\`${key}\` is already a task in \`${draft.name}\`.`);
  }
}

export function createTask(folder: string, body: CreateDraftTaskRequest): DraftTaskCreateResult {
  const request = `POST ${draftPath(folder)}/tasks`;
  const draft = findDraft(folder, request);
  writable(draft, request);
  const added: FixtureTask[] = [];
  if (body.kind === 'blank') {
    const key = body.key ?? freeKey(draft, 'new_task');
    checkKey(draft, key, request);
    added.push(makeTask(key, blankContent(), null, null));
  } else if (body.kind === 'duplicate') {
    const from = draft.tasks.find((t) => t.key === body.from);
    if (!from) throw new ApiError(404, request, `task ${body.from} is not in the draft`);
    const key = body.key ?? freeKey(draft, `${body.from}_copy`);
    checkKey(draft, key, request);
    added.push(makeTask(key, from, null, null));
  } else if (body.kind === 'restore') {
    const suiteId = body.suiteVersion === 1 ? SUITE_V1_ID : SUITE_V2_ID;
    const old = baseTask(suiteState(), suiteId, body.key);
    if (!old) throw new ApiError(404, request, `task ${body.key} is not in v${body.suiteVersion}`);
    const current = draft.tasks.find((t) => t.key === body.key);
    if (current) {
      Object.assign(current, {
        ...structuredClone(old),
        base: current.base,
        baseContent: current.baseContent,
        position: current.position,
      });
      current.restoredFrom = { taskVersion: old.base!.version, suiteVersion: body.suiteVersion };
      current.removed = false;
      touch(draft, current);
      return { keys: [current.key], draft: draftView(draft) };
    }
    old.restoredFrom = { taskVersion: old.base!.version, suiteVersion: body.suiteVersion };
    old.base = null;
    added.push(old);
  } else {
    for (const key of body.keys) {
      const task = baseTask(suiteState(), SUITE_V1_ID, key);
      if (!task) throw new ApiError(404, request, `task ${key} is not in ${body.suite}`);
      added.push(makeTask(freeKey(draft, key), task, null, null));
    }
  }
  for (const task of added) {
    task.position = draft.tasks.length;
    task.updatedAt = nowIso();
    draft.tasks.push(task);
  }
  touch(draft);
  return { keys: added.map((t) => t.key), draft: draftView(draft) };
}

export function getTask(folder: string, key: string): DraftTaskDetail {
  const [draft, task] = findTask(folder, key, `GET ${draftPath(folder)}/tasks/${key}`);
  return taskDetailView(draft, task);
}

export function putTask(
  folder: string,
  key: string,
  body: UpdateDraftTaskRequest,
): DraftTaskDetail {
  const request = `PUT ${draftPath(folder)}/tasks/${key}`;
  const [draft, task] = findTask(folder, key, request);
  writable(draft, request);
  if (body.revision !== undefined && body.revision !== task.revision) {
    throw new ApiError(409, request, `${key} changed since revision ${body.revision}; reload it`);
  }
  if (body.key !== undefined && body.key !== task.key) {
    checkKey(draft, body.key, request, task);
    task.key = body.key;
  }
  if (body.form) {
    // A JSON copy: a caller may pass a reactive form, which structuredClone refuses.
    task.form = JSON.parse(JSON.stringify(body.form)) as typeof task.form;
    task.taskYaml = taskYamlOf(task.form);
    task.lock = null;
  }
  if (body.taskYaml !== undefined) {
    const read = readTaskYaml(body.taskYaml, task.form);
    task.taskYaml = body.taskYaml;
    task.lock = read.lock;
    if (read.form) task.form = read.form;
  }
  if (body.prompt !== undefined) task.prompt = body.prompt;
  if (body.reference !== undefined) task.reference = body.reference;
  if (body.rubrics) {
    for (const r of body.rubrics) {
      const known = task.rubrics.find((x) => x.path === r.path);
      if (known) known.text = r.text;
      else task.rubrics.push({ ...r });
    }
  }
  if (body.removed === false) task.removed = false;
  touch(draft, task);
  return taskDetailView(draft, task);
}

export function deleteTask(folder: string, key: string): SuiteDraftView {
  const request = `DELETE ${draftPath(folder)}/tasks/${key}`;
  const [draft, task] = findTask(folder, key, request);
  writable(draft, request);
  if (task.base) task.removed = true;
  else draft.tasks.splice(draft.tasks.indexOf(task), 1);
  touch(draft);
  return draftView(draft);
}

export function revertTask(folder: string, key: string): DraftTaskDetail {
  const request = `POST ${draftPath(folder)}/tasks/${key}/revert`;
  const [draft, task] = findTask(folder, key, request);
  if (!task.base || !task.baseContent)
    throw new ApiError(409, request, `${key} is new in this draft`);
  Object.assign(task, structuredClone(task.baseContent));
  Object.assign(task, { key: task.base.key, removed: false, restoredFrom: null, lock: null });
  task.refused = [];
  task.taskYaml = taskYamlOf(task.form);
  touch(draft, task);
  return taskDetailView(draft, task);
}

/** The task's refused uploads but the one at `path`. */
const withoutRefusal = (task: FixtureTask, path: string) =>
  (task.refused ?? []).filter((r) => r.path !== path);

/** The folder a kind of upload lands in. */
function folderOf(kind: DraftFileUploadFields['kind'], task: FixtureTask): string {
  if (kind === 'fixture') return 'fixtures';
  if (kind === 'home_seed') return 'home';
  if (kind === 'expected_home') return task.form.expectedHome ?? 'expected_home';
  return task.form.expectedWorkspace ?? 'expected';
}

export async function uploadFile(
  folder: string,
  key: string,
  file: File,
  fields: DraftFileUploadFields,
): Promise<DraftTaskDetail> {
  const request = `POST ${draftPath(folder)}/tasks/${key}/files`;
  const [draft, task] = findTask(folder, key, request);
  writable(draft, request);
  const path = `${folderOf(fields.kind, task)}/${fields.path ?? file.name}`;
  if (file.size > AUTHORING_LIMITS.suiteMaxFileBytes) {
    // Kept on the task, so readiness still reports it after a reload (Phase 5b #11).
    task.refused = [
      ...withoutRefusal(task, path),
      {
        path,
        kind: fields.kind,
        sizeBytes: null,
        limitBytes: AUTHORING_LIMITS.suiteMaxFileBytes,
        refusedAt: nowIso(),
      },
    ];
    touch(draft, task);
    throw new ApiError(413, request, `${file.name} is over 25 MB`);
  }
  if (isVerifyPath(path))
    throw new ApiError(400, request, 'verify/ holds code and is edited on disk only');
  if (fields.kind === 'expected' && !task.form.expectedWorkspace) {
    task.form.expectedWorkspace = 'expected';
    task.taskYaml = taskYamlOf(task.form);
  }
  task.refused = withoutRefusal(task, path);
  const textual = file.size < 1024 * 1024 && /\.(csv|tsv|txt|md|json|ya?ml)$/i.test(file.name);
  const text = textual ? await file.text() : null;
  task.files = task.files.filter((f) => f.path !== path);
  task.files.push(
    fileView(path, kindOfPath(path, task.form), file.size, typeLabelOf(file.name, text)),
  );
  if (text !== null) task.texts[path] = text;
  touch(draft, task);
  return taskDetailView(draft, task);
}

export function moveFile(folder: string, key: string, from: string, to: string): DraftTaskDetail {
  const request = `PATCH ${draftPath(folder)}/tasks/${key}/files/${from}`;
  const [draft, task] = findTask(folder, key, request);
  if (isVerifyPath(from) || isVerifyPath(to))
    throw new ApiError(400, request, 'verify/ holds code and is edited on disk only');
  const file = task.files.find((f) => f.path === from);
  if (!file) throw new ApiError(404, request, `${from} is not in ${key}`);
  Object.assign(
    file,
    fileView(to, kindOfPath(to, task.form), file.sizeBytes, file.typeLabel, file.sha256),
  );
  const { [from]: text, ...others } = task.texts;
  task.texts = text === undefined ? others : { ...others, [to]: text };
  task.refused = withoutRefusal(task, to);
  touch(draft, task);
  return taskDetailView(draft, task);
}

export function deleteFile(folder: string, key: string, path: string): DraftTaskDetail {
  const request = `DELETE ${draftPath(folder)}/tasks/${key}/files/${path}`;
  const [draft, task] = findTask(folder, key, request);
  if (isVerifyPath(path))
    throw new ApiError(400, request, 'verify/ holds code and is edited on disk only');
  // Deleting the path of a refused upload dismisses the refusal (Phase 5b #11).
  task.refused = withoutRefusal(task, path);
  task.files = task.files.filter((f) => f.path !== path);
  touch(draft, task);
  return taskDetailView(draft, task);
}

/** A file's text (a verifier source for View, a text fixture), or null for binary content. */
export function fileText(folder: string, key: string, path: string): string | null {
  const [, task] = findTask(folder, key, `GET ${draftPath(folder)}/tasks/${key}/files/${path}`);
  return task.texts[path] ?? null;
}

export function selfCheck(folder: string, key: string): DraftSelfCheckView {
  const request = `POST ${draftPath(folder)}/tasks/${key}/self-check`;
  const [draft, task] = findTask(folder, key, request);
  if (hasScenario('no-worker')) {
    throw new ApiError(
      503,
      request,
      'no worker is running: start it with docker compose up -d worker',
    );
  }
  const outcome = hasScenario('self-check-failed')
    ? 'failed'
    : hasScenario('self-check-negative')
      ? 'failed-negative'
      : hasScenario('self-check-error')
        ? 'error'
        : 'passed';
  task.selfCheck = fixtureSelfCheck(
    task.form,
    outcome,
    nowIso(),
    `${folder}/${key}/${task.revision}`,
  );
  draft.updatedAt = nowIso();
  return structuredClone(task.selfCheck);
}

export function tryCheck(folder: string, key: string, body: TryCheckRequest): TryCheckResult {
  const request = `POST ${draftPath(folder)}/tasks/${key}/try`;
  const [, task] = findTask(folder, key, request);
  const result = fixtureTry(task.form, task.reference, body.key, body.reply);
  if (!result) throw new ApiError(400, request, `${body.key} is not an answer check of ${key}`);
  return result;
}
