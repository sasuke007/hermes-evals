import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Res,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { ApiParam, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import {
  AUTHORING_LIMITS,
  CreateDraftTaskRequestSchema,
  DraftFileUploadFieldsSchema,
  DraftTaskCreateResultSchema,
  DraftTaskDetailSchema,
  DraftTaskDiffSchema,
  DraftTaskKeySchema,
  MoveDraftFileRequestSchema,
  SuiteDraftViewSchema,
  SuiteFolderSchema,
  TablePreviewSchema,
  TaskReadinessSchema,
  TryCheckRequestSchema,
  TryCheckResultSchema,
  UpdateDraftTaskRequestSchema,
  type CreateDraftTaskRequest,
  type DraftFileUploadFields,
  type DraftTaskCreateResult,
  type DraftTaskDetail,
  type DraftTaskDiff,
  type MoveDraftFileRequest,
  type SuiteDraftView,
  type TaskReadiness,
  type TryCheckRequest,
  type TryCheckResult,
  type UpdateDraftTaskRequest,
} from '@hermes-evals/shared';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import {
  ApiFileResponse,
  ApiFileUpload,
  ApiJsonBody,
  ApiJsonResponse,
} from '../../openapi/decorators.js';
import { SingleFileUpload, type UploadedFileRef } from '../../resources/skills/multipart-upload.js';
import { streamFailure } from '../../resources/skills/http.js';
import { attachmentDisposition, contentTypeFor } from '../views/download.js';
import { DraftFilesService } from './draft-files.service.js';
import { DraftTasksService } from './draft-tasks.service.js';

const folderPipe = new ZodValidationPipe(SuiteFolderSchema);
const keyPipe = new ZodValidationPipe(DraftTaskKeySchema);
const FILE_PATH =
  "The file's path in the task folder, URL-encoded as one segment (fixtures%2Finvoices.csv)";

/**
 * The tasks of a suite draft and their files (plan 4.6 and 11; SA.4 to
 * SA.8). Every write is stored at once and checked again (readiness);
 * writes under verify/ are refused (R7). The worker self-check
 * (POST …/self-check) belongs to the save module.
 */
@ApiTags('suite drafts')
@ApiParam({ name: 'suite', description: 'The suite folder, e.g. invoices-v1' })
@Controller('suites/:suite/draft/tasks')
export class DraftTasksController {
  constructor(
    @Inject(DraftTasksService) private readonly tasks: DraftTasksService,
    @Inject(DraftFilesService) private readonly files: DraftFilesService,
  ) {}

  @Post()
  @ApiJsonBody(CreateDraftTaskRequestSchema, {
    description: 'Blank, duplicate, restore of an older version, or copy from another suite',
  })
  @ApiJsonResponse(DraftTaskCreateResultSchema, {
    status: 201,
    description: 'The keys added or restored, and the draft',
  })
  create(
    @Param('suite', folderPipe) folder: string,
    @Body(new ZodValidationPipe(CreateDraftTaskRequestSchema)) body: CreateDraftTaskRequest,
  ): Promise<DraftTaskCreateResult> {
    return this.tasks.create(folder, body);
  }

  @Get(':key')
  @ApiJsonResponse(DraftTaskDetailSchema, { description: 'The task as the editor shows it' })
  detail(
    @Param('suite', folderPipe) folder: string,
    @Param('key', keyPipe) key: string,
  ): Promise<DraftTaskDetail> {
    return this.tasks.detail(folder, key);
  }

  @Put(':key')
  @ApiJsonBody(UpdateDraftTaskRequestSchema, {
    description: 'What changed: key, the form or task.yaml, prompt, reference, rubrics',
  })
  @ApiJsonResponse(DraftTaskDetailSchema, {
    description: 'The task after the change, checked again',
  })
  update(
    @Param('suite', folderPipe) folder: string,
    @Param('key', keyPipe) key: string,
    @Body(new ZodValidationPipe(UpdateDraftTaskRequestSchema)) body: UpdateDraftTaskRequest,
  ): Promise<DraftTaskDetail> {
    return this.tasks.update(folder, key, body);
  }

  @Delete(':key')
  @ApiJsonResponse(SuiteDraftViewSchema, {
    description: 'A base task is marked removed, an added one dropped',
  })
  remove(
    @Param('suite', folderPipe) folder: string,
    @Param('key', keyPipe) key: string,
  ): Promise<SuiteDraftView> {
    return this.tasks.remove(folder, key);
  }

  @Post(':key/revert')
  @HttpCode(200)
  @ApiJsonResponse(DraftTaskDetailSchema, { description: "The base version's files again" })
  revert(
    @Param('suite', folderPipe) folder: string,
    @Param('key', keyPipe) key: string,
  ): Promise<DraftTaskDetail> {
    return this.tasks.revert(folder, key);
  }

  @Get(':key/readiness')
  @ApiJsonResponse(TaskReadinessSchema, { description: 'The 13 readiness rules' })
  readiness(
    @Param('suite', folderPipe) folder: string,
    @Param('key', keyPipe) key: string,
  ): Promise<TaskReadiness> {
    return this.tasks.readiness(folder, key);
  }

  @Post(':key/try')
  @HttpCode(200)
  @ApiJsonBody(TryCheckRequestSchema, {
    description: 'An answer check on the reference, or on a pasted reply',
  })
  @ApiJsonResponse(TryCheckResultSchema, {
    description: 'Extraction and the scorer, run in the API; nothing is stored',
  })
  try(
    @Param('suite', folderPipe) folder: string,
    @Param('key', keyPipe) key: string,
    @Body(new ZodValidationPipe(TryCheckRequestSchema)) body: TryCheckRequest,
  ): Promise<TryCheckResult> {
    return this.tasks.try(folder, key, body);
  }

  @Get(':key/diff')
  @ApiJsonResponse(DraftTaskDiffSchema, { description: 'The task against its base version' })
  diff(
    @Param('suite', folderPipe) folder: string,
    @Param('key', keyPipe) key: string,
  ): Promise<DraftTaskDiff> {
    return this.tasks.diff(folder, key);
  }

  @Post(':key/files')
  @UseInterceptors(SingleFileUpload('file', AUTHORING_LIMITS.suiteMaxFileBytes))
  @ApiFileUpload(
    'file',
    'A workspace, expected or home file, at most 25 MB; fields `kind` and `path`',
  )
  @ApiJsonResponse(DraftTaskDetailSchema, { status: 201, description: 'The task with the file' })
  upload(
    @Param('suite', folderPipe) folder: string,
    @Param('key', keyPipe) key: string,
    @UploadedFile() file: UploadedFileRef | undefined,
    @Body(new ZodValidationPipe(DraftFileUploadFieldsSchema)) fields: DraftFileUploadFields,
  ): Promise<DraftTaskDetail> {
    return this.files.upload(folder, key, file, fields);
  }

  @Patch(':key/files/:path')
  @ApiParam({ name: 'path', description: FILE_PATH })
  @ApiJsonBody(MoveDraftFileRequestSchema, {
    description: "The file's new path in the task folder",
  })
  @ApiJsonResponse(DraftTaskDetailSchema, { description: 'The task with the file moved' })
  move(
    @Param('suite', folderPipe) folder: string,
    @Param('key', keyPipe) key: string,
    @Param('path') path: string,
    @Body(new ZodValidationPipe(MoveDraftFileRequestSchema)) body: MoveDraftFileRequest,
  ): Promise<DraftTaskDetail> {
    return this.files.move(folder, key, path, body);
  }

  @Delete(':key/files/:path')
  @ApiParam({ name: 'path', description: FILE_PATH })
  @ApiJsonResponse(DraftTaskDetailSchema, { description: 'The task without the file' })
  removeFile(
    @Param('suite', folderPipe) folder: string,
    @Param('key', keyPipe) key: string,
    @Param('path') path: string,
  ): Promise<DraftTaskDetail> {
    return this.files.remove(folder, key, path);
  }

  @Get(':key/files/:path')
  @ApiParam({ name: 'path', description: FILE_PATH })
  @ApiFileResponse('The file, as a download; verifier scripts too, read-only', [
    'application/octet-stream',
  ])
  async file(
    @Param('suite', folderPipe) folder: string,
    @Param('key', keyPipe) key: string,
    @Param('path') path: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const download = await this.files.download(folder, key, path);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const file = new StreamableFile(download.stream, {
      type: contentTypeFor(download.path),
      disposition: attachmentDisposition(download.path),
      length: download.size,
    });
    file.setErrorHandler(streamFailure);
    return file;
  }

  @Get(':key/files/:path/preview')
  @ApiParam({ name: 'path', description: FILE_PATH })
  @ApiJsonResponse(TablePreviewSchema, {
    nullable: true,
    description: 'The first rows of a CSV or TSV file; null for any other file',
  })
  async preview(
    @Param('suite', folderPipe) folder: string,
    @Param('key', keyPipe) key: string,
    @Param('path') path: string,
    @Res() res: Response,
  ): Promise<void> {
    // Sent by hand: Nest answers a null return value with an empty body, and null is the answer.
    res.json(await this.files.preview(folder, key, path));
  }
}
