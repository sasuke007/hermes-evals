import {
  applyDecorators,
  Body,
  Controller,
  HttpCode,
  Inject,
  Param,
  Post,
  UploadedFile,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBody, ApiConsumes, ApiParam, ApiTags } from '@nestjs/swagger';
import {
  AUTHORING_LIMITS,
  SuiteDraftViewSchema,
  SuiteFolderSchema,
  SuiteZipImportRequestSchema,
  SuiteZipValidationSchema,
  TaskImportRefusalBodySchema,
  TaskImportResultSchema,
  TaskImportSettingsSchema,
  TaskImportValidationSchema,
  type SuiteDraftView,
  type SuiteZipImportRequest,
  type SuiteZipValidation,
  type TaskImportResult,
  type TaskImportSettings,
  type TaskImportValidation,
} from '@hermes-evals/shared';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { ApiFileUpload, ApiJsonBody, ApiJsonResponse } from '../../openapi/decorators.js';
import { formatBytes } from '../../resources/skills/format.js';
import { badRequest } from '../../resources/skills/http.js';
import { SingleFileUpload, type UploadedFileRef } from '../../resources/skills/multipart-upload.js';
import { MAX_WORKSPACE_FILES, TaskImportUpload, type TaskImportFiles } from './import-upload.js';
import { SuiteImportService, type TaskImportInput } from './suite-import.service.js';
import { SuiteZipImports } from './suite-zip-imports.js';

const SUITE_PARAM = 'The suite folder under SUITES_DIR, e.g. invoices-v1';

/** The multipart body of a task import: the file, the settings as JSON, the workspace files. */
const ApiTaskImportBody = (settingsRequired: boolean): MethodDecorator =>
  applyDecorators(
    ApiConsumes('multipart/form-data'),
    ApiBody({
      description: `The CSV or JSONL file (at most ${formatBytes(AUTHORING_LIMITS.taskImportMaxBytes)} and ${AUTHORING_LIMITS.taskImportMaxRows} rows), the shared settings as TaskImportSettings JSON, and up to ${MAX_WORKSPACE_FILES} workspace files`,
      schema: {
        type: 'object',
        required: settingsRequired ? ['file', 'settings'] : ['file'],
        properties: {
          file: { type: 'string', format: 'binary' },
          settings: { type: 'string', description: 'TaskImportSettings as JSON' },
          workspace: { type: 'array', items: { type: 'string', format: 'binary' } },
        },
      },
    }),
  );

const folderOf = (suite: string): string => {
  const parsed = SuiteFolderSchema.safeParse(suite);
  if (!parsed.success) throw badRequest(`${suite} is not a suite folder name`);
  return parsed.data;
};

/** The multipart `settings` field: absent, or TaskImportSettings as JSON. */
function settingsOf(raw: unknown): TaskImportSettings | null {
  if (raw === undefined || raw === '') return null;
  if (typeof raw !== 'string')
    throw badRequest("send the settings once, as JSON in the field 'settings'");
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw badRequest("the field 'settings' is not valid JSON");
  }
  return new ZodValidationPipe(TaskImportSettingsSchema).transform(json);
}

function inputOf(
  files: TaskImportFiles | undefined,
  body: Record<string, unknown> | undefined,
): TaskImportInput {
  const [file] = files?.file ?? [];
  if (!file) throw badRequest("attach the CSV or JSONL file as the multipart field 'file'");
  return { file, settings: settingsOf(body?.settings), workspace: files?.workspace ?? [] };
}

/**
 * Imports (plan 4.6, SA.9 and SA.10): tasks from CSV or JSONL into the open
 * draft of a suite folder, and a suite from a .zip as the draft of a new
 * suite. Validation stores nothing a draft names; each confirm adds to or
 * opens a draft, and nothing reaches ./suites until it is saved.
 */
@ApiTags('suites')
@Controller('suites')
export class SuiteImportController {
  constructor(
    @Inject(SuiteImportService) private readonly imports: SuiteImportService,
    @Inject(SuiteZipImports) private readonly zips: SuiteZipImports,
  ) {}

  /** Steps 1 and 4 of ImportTasks: the file as read and, with settings, the preview. */
  @Post(':suite/draft/import/validate')
  @HttpCode(200)
  @UseInterceptors(TaskImportUpload)
  @ApiParam({ name: 'suite', description: SUITE_PARAM })
  @ApiTaskImportBody(false)
  @ApiJsonResponse(TaskImportValidationSchema, {
    description: 'The file, why it cannot be imported, or the preview of the tasks it gives',
  })
  validateTasks(
    @Param('suite') suite: string,
    @UploadedFiles() files: TaskImportFiles | undefined,
    @Body() body: Record<string, unknown> | undefined,
  ): Promise<TaskImportValidation> {
    return this.imports.validateTasks(folderOf(suite), inputOf(files, body));
  }

  /** Adds every row as a task of the draft; 422 with the preview while a row needs a fix. */
  @Post(':suite/draft/import')
  @UseInterceptors(TaskImportUpload)
  @ApiParam({ name: 'suite', description: SUITE_PARAM })
  @ApiTaskImportBody(true)
  @ApiJsonResponse(TaskImportResultSchema, {
    status: 201,
    description: 'The keys added and the draft; nothing is added while a row needs a fix (422)',
  })
  @ApiJsonResponse(TaskImportRefusalBodySchema, {
    status: 422,
    description: 'The mapping has a problem or a row needs a fix: the preview with those rows',
  })
  importTasks(
    @Param('suite') suite: string,
    @UploadedFiles() files: TaskImportFiles | undefined,
    @Body() body: Record<string, unknown> | undefined,
  ): Promise<TaskImportResult> {
    const input = inputOf(files, body);
    const { settings } = input;
    if (settings === null)
      throw badRequest("send the import settings as JSON in the field 'settings'");
    return this.imports.importTasks(folderOf(suite), { ...input, settings });
  }

  /** Step 1 of ImportSuiteDialog: checks the zip by the rules a reload uses; no script runs. */
  @Post('import/validate')
  @HttpCode(200)
  @UseInterceptors(SingleFileUpload('file', AUTHORING_LIMITS.suiteZipMaxBytes))
  @ApiFileUpload('file', 'The suite as a .zip, at most 100 MB')
  @ApiJsonResponse(SuiteZipValidationSchema, {
    description: 'What the zip holds, its verifier scripts, and a token to import it with',
  })
  validateZip(@UploadedFile() file: UploadedFileRef | undefined): Promise<SuiteZipValidation> {
    if (!file) throw badRequest("attach the suite zip as the multipart field 'file'");
    return this.zips.validate(file);
  }

  /** Step 2: the validated zip as the draft of a new suite; 409 until its scripts are trusted. */
  @Post('import')
  @ApiJsonBody(SuiteZipImportRequestSchema)
  @ApiJsonResponse(SuiteDraftViewSchema, {
    status: 201,
    description: 'The draft of the new suite, every task added, to save as v1 after review',
  })
  importZip(
    @Body(new ZodValidationPipe(SuiteZipImportRequestSchema)) body: SuiteZipImportRequest,
  ): Promise<SuiteDraftView> {
    return this.imports.importZip(body);
  }
}
