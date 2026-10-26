/**
 * The files of a draft task (plan 4.6; SA.6): uploads to the blob store
 * first (the same temp-file, fsync and rename path as every blob), then a
 * file row; rename or move; delete; and reads of any file, verifier scripts
 * included, which the editor shows read-only. Every write under `verify/`
 * is refused (R7): code reaches a draft only through a confirmed zip.
 */
import { Inject, Injectable } from '@nestjs/common';
import {
  DraftFilePathSchema,
  HOME_MEMORIES_DIR,
  HOME_SEED_PATHS,
  isVerifyPath,
  TASK_HOME_DIR,
  type DraftFileUploadFields,
  type DraftTaskDetail,
  type MoveDraftFileRequest,
  type TablePreview,
} from '@hermes-evals/shared';
import { Readable } from 'node:stream';
import { DB } from '../../database/db.provider.js';
import type { AppDb } from '../../database/types.js';
import { uploadFileName } from '../../resources/skills/format.js';
import type { UploadedFileRef } from '../../resources/skills/multipart-upload.js';
import { StorageService } from '../../storage/storage.service.js';
import { badRequest, notFound } from '../http-errors.js';
import { FIXTURES_DIR, PROMPT_MD, REFERENCE_JSON, TASK_YAML } from '../loader/limits.js';
import { tablePreview, tabularFormatOf } from '../views/table.js';
import { draftFileKind, folderFiles, layoutOf } from './draft-folder.js';
import { requireDraft } from './draft-reads.js';
import { folderOf, loadDraft } from './draft-store.js';
import { DraftTasksService } from './draft-tasks.service.js';
import { conflict, DraftWriter } from './draft-writer.js';
import type { DraftFileRef } from './materialise.js';
import { applyForm, formOf } from './task-form.js';

/** A file of a draft task to send: its bytes as a stream, its name and size. */
export interface DraftFileDownload {
  path: string;
  size: number;
  stream: Readable;
}

const R7 = 'verify/ holds code and is edited on disk only';

/** Refuses a path under verify/ (R7), whatever case or form it is written in. */
function refuseVerify(path: string): void {
  if (isVerifyPath(path)) throw badRequest(`${path}: ${R7}`);
}

/** The checked path, or 400 with the schema's reason. */
function checkedPath(path: string): string {
  refuseVerify(path);
  const parsed = DraftFilePathSchema.safeParse(path);
  if (!parsed.success) throw badRequest(`${path}: ${parsed.error.issues[0]!.message}`);
  return parsed.data;
}

/** A path that would sit inside a file, or hold one inside it. */
function clash(path: string, taken: readonly string[]): string | undefined {
  return taken.find((p) => p === path || p.startsWith(`${path}/`) || path.startsWith(`${p}/`));
}

@Injectable()
export class DraftFilesService {
  private readonly writer: DraftWriter;

  constructor(
    @Inject(DB) private readonly db: AppDb,
    @Inject(StorageService) private readonly storage: StorageService,
    @Inject(DraftTasksService) private readonly tasks: DraftTasksService,
  ) {
    this.writer = new DraftWriter(db, storage);
  }

  /**
   * POST …/tasks/:key/files: one file of a kind, at `path` inside the kind's
   * folder (the file's own name when absent). An expected file or home file
   * names its folder in task.yaml when the task has none yet. A file at a
   * path the task already holds is replaced.
   */
  async upload(
    folder: string,
    key: string,
    file: UploadedFileRef | undefined,
    fields: DraftFileUploadFields,
  ): Promise<DraftTaskDetail> {
    if (!file) throw badRequest("send the file in the multipart field 'file'");
    const name = fields.path ?? uploadFileName(file.originalname, 'file');
    refuseVerify(name);
    const ref = await this.storage.putFile(file.path);
    await this.writer.write(folder, undefined, async (ctx) => {
      const task = ctx.task(key);
      const current = folderOf(ctx.stored, task);
      const layout = layoutOf(current.taskYaml);
      let taskYaml = current.taskYaml;
      let path: string;
      switch (fields.kind) {
        case 'fixture':
          path = `${FIXTURES_DIR}/${name}`;
          break;
        case 'home_seed': {
          const seed = name.startsWith(`${HOME_MEMORIES_DIR}/`)
            ? name
            : `${HOME_MEMORIES_DIR}/${name}`;
          path = `${TASK_HOME_DIR}/${seed}`;
          if (!(HOME_SEED_PATHS as readonly string[]).includes(path)) {
            throw badRequest(
              `a home seed is ${HOME_SEED_PATHS.map((p) => p.slice(5)).join(' or ')}`,
            );
          }
          break;
        }
        case 'expected':
          path = `${layout.expectedDir ?? 'expected'}/${name}`;
          if (layout.expectedDir === null)
            taskYaml = this.withFolder(current.taskYaml, 'expectedWorkspace', 'expected');
          break;
        case 'expected_home': {
          const inHome = name.startsWith(`${HOME_MEMORIES_DIR}/`)
            ? name
            : `${HOME_MEMORIES_DIR}/${name}`;
          path = `${layout.expectedHomeDir ?? 'expected_home'}/${inHome}`;
          if (layout.expectedHomeDir === null)
            taskYaml = this.withFolder(current.taskYaml, 'expectedHome', 'expected_home');
          break;
        }
      }
      path = checkedPath(path);
      const others = folderFiles(current).filter((f) => f.path !== path || f.ref === null);
      const hit = clash(
        path,
        others.map((f) => f.path),
      );
      if (hit !== undefined) throw conflict(`${path} clashes with ${hit} in ${key}`);
      const kind = draftFileKind(path, layoutOf(taskYaml));
      const files: DraftFileRef[] = [
        ...current.files.filter((f) => f.path !== path),
        { path, kind, sha256: ref.sha256, size: ref.size },
      ];
      await ctx.change(task, { taskYaml, files });
    });
    return this.tasks.detail(folder, key);
  }

  /** PATCH …/tasks/:key/files/:path: Rename, or a move into another folder. */
  async move(
    folder: string,
    key: string,
    from: string,
    body: MoveDraftFileRequest,
  ): Promise<DraftTaskDetail> {
    refuseVerify(from);
    const to = checkedPath(body.path);
    await this.writer.write(folder, undefined, async (ctx) => {
      const task = ctx.task(key);
      if (body.revision !== undefined && body.revision !== task.revision) {
        throw conflict(`${key} changed since revision ${body.revision}; reload it`);
      }
      const current = folderOf(ctx.stored, task);
      const file = current.files.find((f) => f.path === from);
      if (!file) throw this.notMovable(current, from);
      const hit = clash(
        to,
        folderFiles(current)
          .filter((f) => f.path !== from)
          .map((f) => f.path),
      );
      if (hit !== undefined) throw conflict(`${to} clashes with ${hit} in ${key}`);
      const kind = draftFileKind(to, layoutOf(current.taskYaml));
      if (kind === 'other' && to.startsWith(`${TASK_HOME_DIR}/`)) {
        throw badRequest(`home/ holds only ${HOME_SEED_PATHS.join(' and ')}`);
      }
      const files = current.files.map((f) => (f.path === from ? { ...f, path: to, kind } : f));
      await ctx.change(task, { files });
    });
    return this.tasks.detail(folder, key);
  }

  /** DELETE …/tasks/:key/files/:path: a blob file or a rubric; never task.yaml, the prompt or the reference. */
  async remove(folder: string, key: string, path: string): Promise<DraftTaskDetail> {
    refuseVerify(path);
    if ([TASK_YAML, PROMPT_MD, REFERENCE_JSON].includes(path)) {
      throw badRequest(`${path} is edited in the form, not deleted`);
    }
    await this.writer.write(folder, undefined, async (ctx) => {
      const task = ctx.task(key);
      const current = folderOf(ctx.stored, task);
      if (Object.hasOwn(current.rubrics, path)) {
        const rubrics = Object.fromEntries(
          Object.entries(current.rubrics).filter(([p]) => p !== path),
        );
        await ctx.change(task, { rubrics });
        return;
      }
      if (!current.files.some((f) => f.path === path)) throw notFound(`file ${path} in ${key}`);
      await ctx.change(task, { files: current.files.filter((f) => f.path !== path) });
    });
    return this.tasks.detail(folder, key);
  }

  /** GET …/tasks/:key/files/:path: the file's bytes. */
  async download(folder: string, key: string, path: string): Promise<DraftFileDownload> {
    const file = await this.fileOf(folder, key, path);
    if (file.text !== null) {
      const bytes = Buffer.from(file.text, 'utf8');
      return { path, size: bytes.length, stream: Readable.from([bytes]) };
    }
    return { path, size: file.ref.size, stream: this.storage.stream(file.ref.sha256) };
  }

  /** GET …/tasks/:key/files/:path/preview: the first rows of a CSV or TSV file; null for any other. */
  async preview(folder: string, key: string, path: string): Promise<TablePreview | null> {
    const file = await this.fileOf(folder, key, path);
    const format = tabularFormatOf(path);
    if (format === null) return null;
    const bytes =
      file.text !== null
        ? Buffer.from(file.text, 'utf8')
        : await this.storage.read(file.ref.sha256);
    return tablePreview(bytes, format);
  }

  // --------------------------------------------------------------------------

  private async fileOf(folder: string, key: string, path: string) {
    const stored = await loadDraft(this.db, await requireDraft(this.db, folder));
    const task = stored.tasks.find((t) => t.key === key);
    if (!task) throw notFound(`task ${key} in the draft of ${folder}`);
    const file = folderFiles(folderOf(stored, task)).find((f) => f.path === path);
    if (!file) throw notFound(`file ${path} in ${key}`);
    return file;
  }

  private notMovable(current: ReturnType<typeof folderOf>, path: string) {
    if (
      Object.hasOwn(current.rubrics, path) ||
      [TASK_YAML, PROMPT_MD, REFERENCE_JSON].includes(path)
    ) {
      return badRequest(`${path} is named by task.yaml; rename it there`);
    }
    return notFound(`file ${path}`);
  }

  /** task.yaml naming a known-good folder, through the form so the rest of the file is kept. */
  private withFolder(
    taskYaml: string | null,
    field: 'expectedWorkspace' | 'expectedHome',
    dir: string,
  ): string | null {
    const read = formOf(taskYaml);
    if (read.form === null)
      throw conflict(
        `task.yaml has an error; name the folder in task.yaml first (${read.lock.message})`,
      );
    return applyForm(taskYaml, { ...read.form, [field]: dir });
  }
}
