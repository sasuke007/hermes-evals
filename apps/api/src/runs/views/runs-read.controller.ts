import { Controller, Get, Inject, Param, Query, Res, StreamableFile } from '@nestjs/common';
import { ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import {
  RUN_SORT_KEYS,
  RUN_STATUSES,
  RunDetailSchema,
  RunEventsPageSchema,
  RunEventsQuerySchema,
  RunListQuerySchema,
  RunListResultSchema,
  SCORE_STATUSES,
  SORT_DIRECTIONS,
  TablePreviewSchema,
  type RunDetail,
  type RunEventsPage,
  type RunEventsQuery,
  type RunFilters,
  type RunListResult,
} from '@hermes-evals/shared';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { ApiFileResponse, ApiJsonResponse } from '../../openapi/decorators.js';
import { attachmentDisposition, contentTypeFor } from '../../suites/views/download.js';
import { RunViewsService } from './run-views.service.js';

/**
 * Agent-written bytes leave as a download the browser saves and never
 * renders: an attachment, no sniffing, and a sandbox with nothing allowed
 * should a browser display it anyway. HTML and SVG have no entry in the
 * type table, so they go out as application/octet-stream.
 */
const ARTIFACT_CSP = "default-src 'none'; sandbox";

/**
 * The run read API (plan 11, UI_FLOWS 17 and 18): the Runs tab, the run
 * inspector and its live event pages, and the artifacts. Read-only; the run
 * actions (re-score, retry, cancel) live in their own controller.
 */
@ApiTags('runs')
@Controller()
export class RunsReadController {
  constructor(@Inject(RunViewsService) private readonly views: RunViewsService) {}

  @Get('experiments/:id/runs')
  @ApiQuery({
    name: 'config',
    required: false,
    description: 'Configuration name or version id; `all` for every one',
  })
  @ApiQuery({ name: 'task', required: false, description: 'Task key; `all` for every task' })
  @ApiQuery({ name: 'status', required: false, enum: RUN_STATUSES })
  @ApiQuery({
    name: 'score_status',
    required: false,
    enum: SCORE_STATUSES,
    description: 'Status of the primary key',
  })
  @ApiQuery({
    name: 'exec_error',
    required: false,
    description: '`1` or `true`: execution errors only',
  })
  @ApiQuery({
    name: 'ungradable',
    required: false,
    description: '`1` or `true`: ungradable primary keys only',
  })
  @ApiQuery({ name: 'sort', required: false, enum: RUN_SORT_KEYS })
  @ApiQuery({ name: 'dir', required: false, enum: SORT_DIRECTIONS })
  @ApiJsonResponse(RunListResultSchema, {
    description:
      'Every run of the experiment that passes the filters, and the counts over all of them',
  })
  async list(
    @Param('id') id: string,
    @Query(new ZodValidationPipe(RunListQuerySchema)) filters: RunFilters,
  ): Promise<RunListResult> {
    return RunListResultSchema.parse(await this.views.list(id, filters));
  }

  @Get('runs/:id')
  @ApiJsonResponse(RunDetailSchema, {
    description:
      'The run inspector: header, attempts, outcome, timeline, final response, artifacts, launch record',
  })
  async detail(@Param('id') id: string): Promise<RunDetail> {
    return RunDetailSchema.parse(await this.views.detail(id));
  }

  @Get('runs/:id/events')
  @ApiQuery({
    name: 'after',
    required: false,
    type: Number,
    description: 'The lastSeq of the previous page (0 for the first)',
  })
  @ApiJsonResponse(RunEventsPageSchema, {
    description:
      'Timeline rows built from events after `after`. A row already sent comes again, with the same seq, when an event completed it (a tool result, a refused connection): replace it by seq.',
  })
  async events(
    @Param('id') id: string,
    @Query(new ZodValidationPipe(RunEventsQuerySchema)) query: RunEventsQuery,
  ): Promise<RunEventsPage> {
    return RunEventsPageSchema.parse(await this.views.events(id, query.after));
  }

  @Get('runs/:id/artifacts/:artifactId/content')
  @ApiParam({ name: 'artifactId', description: 'An artifact of any attempt of this run' })
  @ApiFileResponse('The stored file, as a download', ['application/octet-stream', 'text/csv'])
  async content(
    @Param('id') id: string,
    @Param('artifactId') artifactId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { artifact, stream } = await this.views.artifactContent(id, artifactId);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', ARTIFACT_CSP);
    return new StreamableFile(stream, {
      type: contentTypeFor(artifact.path),
      disposition: attachmentDisposition(artifact.path),
      length: artifact.size,
    });
  }

  @Get('runs/:id/artifacts/:artifactId/preview')
  @ApiParam({ name: 'artifactId', description: 'An artifact of any attempt of this run' })
  @ApiJsonResponse(TablePreviewSchema, {
    nullable: true,
    description: 'The first rows of a CSV or TSV artifact; null for any other file',
  })
  async preview(
    @Param('id') id: string,
    @Param('artifactId') artifactId: string,
    @Res() res: Response,
  ): Promise<void> {
    const preview = await this.views.artifactPreview(id, artifactId);
    // Sent by hand: Nest answers a null return value with an empty body, and null is the answer.
    res.json(preview === null ? null : TablePreviewSchema.parse(preview));
  }
}
