/**
 * The tasks of a suite draft (plan 4.6; SA.4 to SA.8): add (blank,
 * duplicate, restore of an older version, copy from another suite), read,
 * edit (key, form or task.yaml, prompt, reference, rubrics), remove and
 * undo, revert to the base, readiness, Try it, and the diff against the
 * base. Writes go through DraftWriter; the form is written back through the
 * byte-stable patcher (task-form.ts), and the texts are stored as typed.
 */
import { HttpException, Inject, Injectable } from '@nestjs/common';
import type {
  CreateDraftTaskRequest,
  DraftTaskCreateResult,
  DraftTaskDetail,
  SuiteDraftView,
  TaskReadiness,
  TryCheckRequest,
  TryCheckResult,
  UpdateDraftTaskRequest,
} from '@hermes-evals/shared';
import { DB } from '../../database/db.provider.js';
import type { DraftSelfCheckRecord } from '../../database/schema/index.js';
import type { AppDb } from '../../database/types.js';
import { StorageService } from '../../storage/storage.service.js';
import { badRequest, notFound } from '../http-errors.js';
import { sourceOf, suiteById } from '../suites.queries.js';
import type { SuiteRow } from '../views/rows.js';
import { baseTaskFolder, draftFileKind, layoutOf } from './draft-folder.js';
import { draftViewOf, requireDraft, viewInput } from './draft-reads.js';
import { recordOf } from './draft-evaluate.js';
import {
  folderOf,
  storedTasks,
  suiteVersion,
  type DraftTaskDbRow,
  type StoredTask,
} from './draft-store.js';
import { fileViews, taskDetail } from './draft-task-views.js';
import { draftRef } from './draft-views.js';
import { conflict, DraftWriter, type WriteContext } from './draft-writer.js';
import type { DraftFileRef, DraftTaskFolder } from './materialise.js';
import { evaluateReadiness } from './readiness.js';
import { applyForm, BLANK_FORM, FormLockedError, newTaskYaml } from './task-form.js';
import { tryCheck } from './try-check.js';
import { draftTaskDiff } from './draft-diff.js';

/** `new_task`, `new_task_2`, …: the first of `stem` and its numbered forms no task holds. */
export function freeKey(stem: string, taken: readonly string[]): string {
  if (!taken.includes(stem)) return stem;
  for (let n = 2; ; n++) if (!taken.includes(`${stem}_${n}`)) return `${stem}_${n}`;
}

/** Files re-classified for task.yaml's folders: an expected folder named or renamed changes kinds. */
export const reclassify = (
  files: readonly DraftFileRef[],
  taskYaml: string | null,
): DraftFileRef[] => {
  const layout = layoutOf(taskYaml);
  return files.map((f) => ({ ...f, kind: draftFileKind(f.path, layout) }));
};

@Injectable()
export class DraftTasksService {
  private readonly writer: DraftWriter;

  constructor(
    @Inject(DB) private readonly db: AppDb,
    @Inject(StorageService) private readonly storage: StorageService,
  ) {
    this.writer = new DraftWriter(db, storage);
  }

  private readonly read = (sha256: string) => this.storage.read(sha256);

  /** POST /suites/:suite/draft/tasks. */
  async create(folder: string, body: CreateDraftTaskRequest): Promise<DraftTaskCreateResult> {
    // Rows of stored versions are read before the write's transaction locks the draft.
    const source =
      body.kind === 'restore'
        ? await this.versionTasks(folder, body.suiteVersion, [body.key])
        : body.kind === 'copy'
          ? await this.versionTasks(body.suite, body.versionNumber, body.keys)
          : [];
    const folders = await Promise.all(
      source.map(async (s) => ({
        stored: s,
        folder: (await baseTaskFolder(s.task, s.files, s.roots, this.read)).folder,
      })),
    );
    const keys = await this.writer.write(folder, undefined, async (ctx) => {
      const taken = ctx.stored.tasks.map((t) => t.key);
      switch (body.kind) {
        case 'blank': {
          const key = body.key ?? freeKey('new_task', taken);
          const task: DraftTaskFolder = {
            key,
            taskYaml: newTaskYaml(BLANK_FORM),
            prompt: '',
            reference: null,
            rubrics: {},
            files: [],
          };
          return [(await ctx.insert(task, {})).key];
        }
        case 'duplicate': {
          const from = ctx.task(body.from);
          const key = body.key ?? freeKey(`${body.from}_copy`, taken);
          const copy = { ...folderOf(ctx.stored, from), key };
          return [
            (await ctx.insert(copy, { selfCheck: from.selfCheck, position: from.position + 1 }))
              .key,
          ];
        }
        case 'restore':
          return [await restore(ctx, folders[0]!.stored, folders[0]!.folder)];
        case 'copy': {
          for (const key of body.keys)
            if (taken.includes(key)) throw conflict(`${key} is already a task in ${folder}.`);
          const out: string[] = [];
          for (const f of folders)
            out.push((await ctx.insert(f.folder, { selfCheck: recordOf(f.stored.task) })).key);
          return out;
        }
      }
    });
    return { keys, draft: await this.draftView(folder) };
  }

  /** GET /suites/:suite/draft/tasks/:key. */
  async detail(folder: string, key: string): Promise<DraftTaskDetail> {
    const draft = await requireDraft(this.db, folder);
    const input = await viewInput(this.db, draft, new Date());
    const task = input.stored.tasks.find((t) => t.key === key);
    if (!task) throw notFound(`task ${key} in the draft of ${folder}`);
    const taskFolder = folderOf(input.stored, task);
    const base = task.baseTaskId
      ? (input.base.tasks.find((t) => t.id === task.baseTaskId) ?? null)
      : null;
    const restored = task.restoredFromTaskId
      ? input.restored.get(task.restoredFromTaskId)
      : undefined;
    const records = [task.selfCheck, recordOf(base), recordOf(restored?.task ?? null)];
    const selfCheck =
      records.find((r) => r !== null && r.content_hash === task.contentHash) ?? task.selfCheck;
    return taskDetail({
      ref: draftRef(draft, input.base, input.nextVersion),
      task,
      folder: taskFolder,
      files: await fileViews(taskFolder, this.read),
      base:
        base && input.base.suite
          ? {
              key: base.key,
              version: base.versionNumber,
              suiteVersion: input.base.suite.versionNumber,
            }
          : null,
      restoredFrom: restored
        ? { taskVersion: restored.task.versionNumber, suiteVersion: restored.suite.versionNumber }
        : null,
      readiness:
        task.readiness ?? (await this.readinessNow(folder, input.stored.tasks, task, taskFolder)),
      selfCheck: selfCheck ?? null,
    });
  }

  /** PUT /suites/:suite/draft/tasks/:key: the editor's autosave. */
  async update(
    folder: string,
    key: string,
    body: UpdateDraftTaskRequest,
  ): Promise<DraftTaskDetail> {
    const newKey = await this.writer.write(folder, undefined, async (ctx) => {
      const task = ctx.task(key);
      if (body.revision !== undefined && body.revision !== task.revision) {
        throw conflict(`${key} changed since revision ${body.revision}; reload it`);
      }
      if (
        body.key !== undefined &&
        body.key !== key &&
        ctx.stored.tasks.some((t) => t.key === body.key)
      ) {
        throw conflict(`${body.key} is already a task in ${folder}.`);
      }
      const current = folderOf(ctx.stored, task);
      let taskYaml = current.taskYaml;
      if (body.taskYaml !== undefined) taskYaml = body.taskYaml;
      if (body.form !== undefined) {
        try {
          taskYaml = applyForm(current.taskYaml, body.form);
        } catch (err) {
          if (err instanceof FormLockedError) throw conflict(err.message);
          throw err;
        }
      }
      let rubrics = current.rubrics;
      if (body.rubrics !== undefined) {
        const named = layoutOf(taskYaml).rubrics;
        const stray = body.rubrics.find((r) => !named.includes(r.path));
        if (stray) throw badRequest(`${stray.path} is not the rubric of any llm_judge check`);
        rubrics = { ...rubrics, ...Object.fromEntries(body.rubrics.map((r) => [r.path, r.text])) };
      }
      const row = await ctx.change(task, {
        key: body.key,
        taskYaml,
        prompt: body.prompt,
        reference: body.reference,
        rubrics,
        files: taskYaml !== current.taskYaml ? reclassify(current.files, taskYaml) : undefined,
        removed: body.removed === false ? false : undefined,
      });
      return row.key;
    });
    return this.detail(folder, newKey);
  }

  /** DELETE /suites/:suite/draft/tasks/:key: a base task is marked removed, an added one dropped. */
  async remove(folder: string, key: string): Promise<SuiteDraftView> {
    await this.writer.write(folder, undefined, async (ctx) => {
      const task = ctx.task(key);
      if (task.baseTaskId !== null) await ctx.change(task, { removed: true });
      else await ctx.drop(task);
    });
    return this.draftView(folder);
  }

  /** POST /suites/:suite/draft/tasks/:key/revert: the base version's files and key again. */
  async revert(folder: string, key: string): Promise<DraftTaskDetail> {
    const draft = await requireDraft(this.db, folder);
    const input = await viewInput(this.db, draft, new Date());
    const task = input.stored.tasks.find((t) => t.key === key);
    if (!task) throw notFound(`task ${key} in the draft of ${folder}`);
    const base = task.baseTaskId
      ? input.base.tasks.find((t) => t.id === task.baseTaskId)
      : undefined;
    if (!base || !input.base.suite) throw badRequest(`${key} is new in this draft`);
    const [stored] = await storedTasks(this.db, input.base.suite, [base.key]);
    const original = (await baseTaskFolder(stored!.task, stored!.files, stored!.roots, this.read))
      .folder;
    await this.writer.write(folder, undefined, async (ctx) => {
      const current = ctx.task(key);
      if (base.key !== key && ctx.stored.tasks.some((t) => t.key === base.key)) {
        throw conflict(`${base.key} is already a task in ${folder}.`);
      }
      await ctx.change(current, {
        ...original,
        removed: false,
        restoredFromTaskId: null,
        selfCheck: null,
      });
    });
    return this.detail(folder, base.key);
  }

  /** GET …/tasks/:key/readiness. */
  async readiness(folder: string, key: string): Promise<TaskReadiness> {
    return (await this.detail(folder, key)).readiness;
  }

  /** POST …/tasks/:key/try: Try it, in the API; nothing is stored. */
  async try(folder: string, key: string, body: TryCheckRequest): Promise<TryCheckResult> {
    const detail = await this.detail(folder, key);
    const result = tryCheck({ taskYaml: detail.taskYaml, reference: detail.reference }, body);
    if ('message' in result && !('key' in result)) {
      throw new HttpException(
        { statusCode: result.status, message: result.message },
        result.status,
      );
    }
    return result as TryCheckResult;
  }

  /** GET …/tasks/:key/diff: the task against its base version. */
  async diff(folder: string, key: string) {
    const draft = await requireDraft(this.db, folder);
    const input = await viewInput(this.db, draft, new Date());
    const task = input.stored.tasks.find((t) => t.key === key);
    if (!task) throw notFound(`task ${key} in the draft of ${folder}`);
    const base = task.baseTaskId
      ? input.base.tasks.find((t) => t.id === task.baseTaskId)
      : undefined;
    const stored =
      base && input.base.suite
        ? (await storedTasks(this.db, input.base.suite, [base.key]))[0]
        : undefined;
    const from = stored
      ? (await baseTaskFolder(stored.task, stored.files, stored.roots, this.read)).folder
      : null;
    return draftTaskDiff({
      task,
      folder: folderOf(input.stored, task),
      base: stored ?? null,
      baseFolder: from,
      read: this.read,
    });
  }

  /**
   * Stores a worker self-check of a draft task (the self-check-draft job,
   * B2) and checks the task again, so rows 12 and 13 show it.
   */
  async recordSelfCheck(
    folder: string,
    key: string,
    record: DraftSelfCheckRecord,
  ): Promise<DraftTaskDetail> {
    await this.writer.write(folder, undefined, async (ctx) => {
      await ctx.change(ctx.task(key), { selfCheck: record });
    });
    return this.detail(folder, key);
  }

  // --------------------------------------------------------------------------

  private async draftView(folder: string): Promise<SuiteDraftView> {
    return draftViewOf(this.db, await requireDraft(this.db, folder), new Date());
  }

  private async readinessNow(
    folder: string,
    tasks: readonly DraftTaskDbRow[],
    task: DraftTaskDbRow,
    taskFolder: DraftTaskFolder,
  ) {
    const outcome = await evaluateReadiness(taskFolder, {
      folder,
      otherKeys: tasks.filter((t) => t.id !== task.id).map((t) => t.key),
      renamedFrom: null,
      readBlob: this.read,
      lastSelfCheck: task.selfCheck,
    });
    return outcome.readiness;
  }

  /** Tasks `keys` of a folder's version `n` (its current version when absent), each or 404. */
  private async versionTasks(
    suiteFolder: string,
    n: number | undefined,
    keys: readonly string[],
  ): Promise<StoredTask[]> {
    let suite: SuiteRow | null;
    if (n !== undefined) suite = await suiteVersion(this.db, suiteFolder, n);
    else {
      const source = await sourceOf(this.db, suiteFolder);
      suite = source?.currentSuiteId ? await suiteById(this.db, source.currentSuiteId) : null;
    }
    if (!suite)
      throw notFound(n !== undefined ? `version ${n} of ${suiteFolder}` : `suite ${suiteFolder}`);
    const found = await storedTasks(this.db, suite, keys);
    const missing = keys.find((k) => !found.some((s) => s.task.key === k));
    if (missing !== undefined)
      throw notFound(`task ${missing} in v${suite.versionNumber} of ${suiteFolder}`);
    return keys.map((k) => found.find((s) => s.task.key === k)!);
  }
}

/** Restore: the draft's task of that key takes the older version's files, or the task comes back. */
async function restore(
  ctx: WriteContext,
  stored: StoredTask,
  folder: DraftTaskFolder,
): Promise<string> {
  const existing = ctx.stored.tasks.find((t) => t.key === folder.key);
  if (existing) {
    await ctx.change(existing, {
      ...folder,
      removed: false,
      restoredFromTaskId: stored.task.id,
      selfCheck: null,
    });
    return existing.key;
  }
  return (await ctx.insert(folder, { restoredFromTaskId: stored.task.id })).key;
}
