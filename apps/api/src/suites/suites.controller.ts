import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Res,
  StreamableFile,
} from '@nestjs/common';
import { ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import {
  SuiteDetailSchema,
  SuiteHistoryEntrySchema,
  SuiteListRowSchema,
  SuiteReloadRequestSchema,
  SuiteReloadResultSchema,
  TablePreviewSchema,
  TaskDetailSchema,
  TaskDiffSchema,
  TaskVersionEntrySchema,
  type SuiteDetail,
  type SuiteHistoryEntry,
  type SuiteListRow,
  type SuiteReloadRequest,
  type SuiteReloadResult,
  type TaskDetail,
  type TaskDiff,
  type TaskVersionEntry,
} from '@hermes-evals/shared';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { ApiFileResponse, ApiJsonBody, ApiJsonResponse } from '../openapi/decorators.js';
import { SuiteReloadService } from './suite-reload.service.js';
import { SuiteTasksService } from './suite-tasks.service.js';
import { SuitesService } from './suites.service.js';
import { attachmentDisposition, contentTypeFor } from './views/download.js';

/** A fixture's `:path`: its path in the workspace, URL-encoded as one segment. */
const FIXTURE_PATH_PARAM =
  'Workspace path of the fixture, URL-encoded as one segment (docs%2Freadme.md)';

/** POST /suites/reload may come without a body: the same as `{}`, every directory. */
const ReloadBody = z.preprocess((body) => body ?? {}, SuiteReloadRequestSchema);

/**
 * Suites and tasks, read-only (plan 4.4 and 4.5, UI_FLOWS 8). `:path` of a
 * fixture is one URL-encoded segment, the fixture's path in the workspace.
 */
@ApiTags('suites')
@Controller('suites')
export class SuitesController {
  constructor(
    @Inject(SuitesService) private readonly suites: SuitesService,
    @Inject(SuiteTasksService) private readonly tasks: SuiteTasksService,
    @Inject(SuiteReloadService) private readonly reloads: SuiteReloadService,
  ) {}

  @Get()
  @ApiJsonResponse(SuiteListRowSchema, {
    array: true,
    description: 'One row per suite directory, at its current version',
  })
  list(): Promise<SuiteListRow[]> {
    return this.suites.list();
  }

  @Post('reload')
  @HttpCode(200)
  @ApiJsonBody(SuiteReloadRequestSchema, {
    required: false,
    description: 'No body, or no `path`: every directory under SUITES_DIR',
  })
  @ApiJsonResponse(SuiteReloadResultSchema, {
    description: 'Reloads suites from disk in the worker; one entry per directory',
  })
  reload(
    @Body(new ZodValidationPipe(ReloadBody)) body: SuiteReloadRequest,
  ): Promise<SuiteReloadResult> {
    return this.reloads.reload(body);
  }

  @Get(':id')
  @ApiJsonResponse(SuiteDetailSchema, {
    description: 'A suite version with its tasks and the version selector',
  })
  detail(@Param('id') id: string): Promise<SuiteDetail> {
    return this.suites.detail(id);
  }

  @Get(':id/history')
  @ApiJsonResponse(SuiteHistoryEntrySchema, {
    array: true,
    description: 'Every version of the directory, newest first',
  })
  history(@Param('id') id: string): Promise<SuiteHistoryEntry[]> {
    return this.suites.history(id);
  }

  @Get(':id/tasks/:key')
  @ApiJsonResponse(TaskDetailSchema, { description: 'Task detail' })
  task(@Param('id') id: string, @Param('key') key: string): Promise<TaskDetail> {
    return this.tasks.detail(id, key);
  }

  @Get(':id/tasks/:key/history')
  @ApiJsonResponse(TaskVersionEntrySchema, {
    array: true,
    description: "The task key's versions, newest first",
  })
  taskHistory(@Param('id') id: string, @Param('key') key: string): Promise<TaskVersionEntry[]> {
    return this.tasks.history(id, key);
  }

  @Get(':id/tasks/:key/diff')
  @ApiQuery({
    name: 'against',
    type: String,
    required: true,
    description: 'Id of another version of the same suite directory',
  })
  @ApiJsonResponse(TaskDiffSchema, {
    description: 'The task changes from suite version `against` to this one',
  })
  taskDiff(
    @Param('id') id: string,
    @Param('key') key: string,
    @Query('against') against: string | undefined,
  ): Promise<TaskDiff> {
    return this.tasks.diff(id, key, typeof against === 'string' ? against : undefined);
  }

  @Get(':id/tasks/:key/fixtures/:path')
  @ApiParam({ name: 'path', description: FIXTURE_PATH_PARAM })
  @ApiFileResponse('The fixture file, as a download', ['application/octet-stream', 'text/csv'])
  async fixture(
    @Param('id') id: string,
    @Param('key') key: string,
    @Param('path') path: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const download = await this.tasks.fixture(id, key, path);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return new StreamableFile(download.stream, {
      type: contentTypeFor(download.path),
      disposition: attachmentDisposition(download.path),
      length: download.file.size,
    });
  }

  @Get(':id/tasks/:key/fixtures/:path/preview')
  @ApiParam({ name: 'path', description: FIXTURE_PATH_PARAM })
  @ApiJsonResponse(TablePreviewSchema, {
    nullable: true,
    description: 'The first rows of a CSV or TSV fixture; null for any other file',
  })
  async fixturePreview(
    @Param('id') id: string,
    @Param('key') key: string,
    @Param('path') path: string,
    @Res() res: Response,
  ): Promise<void> {
    // Sent by hand: Nest answers a null return value with an empty body, and null is the answer.
    res.json(await this.tasks.preview(id, key, path));
  }
}
