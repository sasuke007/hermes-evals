/**
 * The import routes (plan 4.6, UI_FLOWS for SA.9 and SA.10): tasks from a
 * CSV or JSONL file into the open draft of a folder, and a validated suite
 * zip as the draft of a new suite. Files go to the blob store first;
 * nothing is written to SUITES_DIR until the draft is saved, and no code
 * from an upload runs. The drafts themselves are the drafts module's,
 * reached through DRAFT_IMPORT_PORT.
 */
import { readFile } from 'node:fs/promises';
import { Inject, Injectable, UnprocessableEntityException } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import {
  DraftFilePathSchema,
  type SuiteDraftView,
  type SuiteZipImportRequest,
  type TaskImportPreview,
  type TaskImportRefusalBody,
  type TaskImportResult,
  type TaskImportSettings,
  type TaskImportValidation,
} from '@hermes-evals/shared';
import { DB } from '../../database/db.provider.js';
import type { AppDb } from '../../database/types.js';
import { uploadFileName } from '../../resources/skills/format.js';
import { badRequest, notFound } from '../../resources/skills/http.js';
import type { UploadedFileRef } from '../../resources/skills/multipart-upload.js';
import { StorageService } from '../../storage/storage.service.js';
import type { DraftFileRef } from '../drafts/materialise.js';
import {
  DRAFT_IMPORT_PORT,
  type DraftForImport,
  type DraftImportPort,
} from './draft-import.port.js';
import { buildImportedTasks, parseTaskTable, type ImportedTasks } from './parsers.js';
import { recordDraftBlobs, SuiteZipImports } from './suite-zip-imports.js';

/** The parts of a task import request. */
export interface TaskImportInput {
  file: UploadedFileRef;
  /** Null on a validation of step 1, which only reads the file. */
  settings: TaskImportSettings | null;
  /** The `workspace` parts, shared by every task when `workspace.from` is `upload`. */
  workspace: readonly UploadedFileRef[];
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** The 422 message: the mapping's first problem, or how many rows need a fix. */
function refusalMessage(preview: TaskImportPreview): string {
  const problem = preview.messages.find((m) => m.severity === 'problem');
  if (problem) return problem.message;
  const n = preview.fixCount;
  return `${n} ${plural(n, 'row needs', 'rows need')} a fix; nothing was added`;
}

@Injectable()
export class SuiteImportService {
  constructor(
    @Inject(DB) private readonly db: AppDb,
    private readonly storage: StorageService,
    private readonly zips: SuiteZipImports,
    @Inject(DRAFT_IMPORT_PORT) private readonly drafts: DraftImportPort,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(SuiteImportService.name);
  }

  /** POST /suites/:suite/draft/import/validate: the file as read and, with settings, the preview. */
  async validateTasks(folder: string, input: TaskImportInput): Promise<TaskImportValidation> {
    const draft = await this.draftOf(folder);
    const table = parseTaskTable(this.fileNameOf(input.file), await readFile(input.file.path));
    if (!table.ok) return { file: table.file, problems: table.problems, preview: null };
    if (input.settings === null) return { file: table.file, problems: [], preview: null };
    const built = await this.build(folder, draft, table.rows, input.settings, input.workspace);
    return { file: table.file, problems: [], preview: built.preview };
  }

  /**
   * POST /suites/:suite/draft/import: adds every row as a task, or nothing:
   * 422 with the preview while the mapping has a problem or a row needs a
   * fix, 400 for a file that cannot be read.
   */
  async importTasks(
    folder: string,
    input: TaskImportInput & { settings: TaskImportSettings },
  ): Promise<TaskImportResult> {
    const draft = await this.draftOf(folder);
    const fileName = this.fileNameOf(input.file);
    const table = parseTaskTable(fileName, await readFile(input.file.path));
    if (!table.ok) {
      const [first] = table.problems;
      throw badRequest(`${fileName} cannot be imported: ${first?.title ?? 'it could not be read'}`);
    }
    const { preview, tasks } = await this.build(
      folder,
      draft,
      table.rows,
      input.settings,
      input.workspace,
    );
    if (preview.fixCount > 0 || preview.messages.some((m) => m.severity === 'problem')) {
      const body: TaskImportRefusalBody = {
        statusCode: 422,
        message: refusalMessage(preview),
        preview,
      };
      throw new UnprocessableEntityException(body);
    }
    await recordDraftBlobs(
      this.db,
      this.storage,
      tasks.flatMap((t) => t.files),
    );
    const view = await this.drafts.addImportedTasks(folder, tasks);
    this.logger.info(
      { folder, file: fileName, added: tasks.length },
      'imported tasks into a draft',
    );
    return { added: tasks.map((t) => t.key), draft: view };
  }

  /** POST /suites/import: the validated zip as the draft of a new suite, named `name`. */
  async importZip(request: SuiteZipImportRequest): Promise<SuiteDraftView> {
    const taken = await this.zips.take(request.token, request.trustScripts);
    await this.zips.assertNameFree(request.name);
    const { manifest } = taken;
    const view = await this.drafts.createImportedSuiteDraft({
      name: request.name,
      versionLabel: manifest.suite.versionLabel,
      description: manifest.suite.description,
      suiteYaml: manifest.suiteYaml,
      tasks: manifest.tasks,
      scriptsTrusted: taken.scriptsTrusted,
    });
    await this.zips.release(request.token);
    this.logger.info(
      { suite: request.name, tasks: manifest.tasks.length, scripts: manifest.scripts.length },
      'imported a suite zip as a draft',
    );
    return view;
  }

  private async draftOf(folder: string): Promise<DraftForImport> {
    const draft = await this.drafts.draftForImport(folder);
    if (!draft) throw notFound(`${folder} has no open draft; open one before importing tasks`);
    return draft;
  }

  private fileNameOf(file: UploadedFileRef): string {
    return uploadFileName(file.originalname, 'tasks.csv');
  }

  /** The tasks the rows become, with the uploaded workspace files stored as fixtures. */
  private async build(
    folder: string,
    draft: DraftForImport,
    rows: Parameters<typeof buildImportedTasks>[0],
    settings: TaskImportSettings,
    workspace: readonly UploadedFileRef[],
  ): Promise<ImportedTasks> {
    const uploads: DraftFileRef[] = [];
    if (settings.workspace.from === 'upload') {
      for (const file of workspace) {
        const path = `fixtures/${uploadFileName(file.originalname, 'file')}`;
        const checked = DraftFilePathSchema.safeParse(path);
        if (!checked.success) {
          throw badRequest(`workspace file ${path}: ${checked.error.issues[0]!.message}`);
        }
        if (uploads.some((u) => u.path === path)) {
          throw badRequest(`workspace file ${path} is uploaded twice`);
        }
        const ref = await this.storage.putFile(file.path);
        uploads.push({ path, kind: 'fixture', sha256: ref.sha256, size: ref.size });
      }
    }
    const byKey = (key: string) => draft.tasks.find((t) => t.key === key) ?? null;
    return buildImportedTasks(rows, settings, {
      folder,
      existingKeys: new Set(draft.tasks.map((t) => t.key)),
      workspaceSource: settings.workspace.from === 'task' ? byKey(settings.workspace.key) : null,
      checksSource: settings.checks.from === 'task' ? byKey(settings.checks.key) : null,
      uploads,
      readBlob: (sha256) => this.storage.read(sha256),
    });
  }
}
