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
  Res,
  StreamableFile,
} from '@nestjs/common';
import { ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import {
  CreateSuiteDraftRequestSchema,
  DraftReviewSchema,
  DraftSummarySchema,
  SuiteDraftViewSchema,
  SuiteFolderSchema,
  UpdateSuiteDraftRequestSchema,
  type CreateSuiteDraftRequest,
  type DraftReview,
  type DraftSummary,
  type SuiteDraftView,
  type UpdateSuiteDraftRequest,
} from '@hermes-evals/shared';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { ApiFileResponse, ApiJsonBody, ApiJsonResponse } from '../../openapi/decorators.js';
import { contentDisposition, streamFailure } from '../../resources/skills/http.js';
import { DB } from '../../database/db.provider.js';
import type { AppDb } from '../../database/types.js';
import { StorageService } from '../../storage/storage.service.js';
import { SuiteDraftsService } from './drafts.service.js';
import { versionZip } from './version-zip.js';

const SUITE_PARAM = 'The suite folder under SUITES_DIR, e.g. invoices-v1';
const folderPipe = new ZodValidationPipe(SuiteFolderSchema);
const versionPipe = new ZodValidationPipe(z.coerce.number().int().positive());

/**
 * Suite drafts (plan 4.6 and 11, Phase 5b): the draft of a folder or a new
 * suite, read, edited and discarded, its review, and a version's files as a
 * zip. A draft's tasks are under DraftTasksController; save and rebase
 * belong to the save module, the imports to the import module. `:suite` is
 * the folder name.
 */
@ApiTags('suite drafts')
@Controller('suites')
export class SuiteDraftsController {
  constructor(
    @Inject(SuiteDraftsService) private readonly drafts: SuiteDraftsService,
    @Inject(DB) private readonly db: AppDb,
    @Inject(StorageService) private readonly storage: StorageService,
  ) {}

  @Get('drafts')
  @ApiJsonResponse(DraftSummarySchema, {
    array: true,
    description: 'Every open draft, last edited first',
  })
  list(): Promise<DraftSummary[]> {
    return this.drafts.list();
  }

  @Post('drafts')
  @ApiJsonBody(CreateSuiteDraftRequestSchema, {
    description: 'A new suite: empty, a copy of a suite, or a validated zip',
  })
  @ApiJsonResponse(SuiteDraftViewSchema, {
    status: 201,
    description: 'The new suite as a draft; 409 when the name is taken',
  })
  create(
    @Body(new ZodValidationPipe(CreateSuiteDraftRequestSchema)) body: CreateSuiteDraftRequest,
  ): Promise<SuiteDraftView> {
    return this.drafts.create(body);
  }

  @Post(':suite/draft')
  @ApiParam({ name: 'suite', description: SUITE_PARAM })
  @ApiJsonResponse(SuiteDraftViewSchema, {
    status: 201,
    description:
      'A draft of the folder on its current version (201), or the one already open (200)',
  })
  async open(
    @Param('suite', folderPipe) folder: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SuiteDraftView> {
    const { created, view } = await this.drafts.open(folder);
    res.status(created ? 201 : 200);
    return view;
  }

  @Get(':suite/draft')
  @ApiParam({ name: 'suite', description: SUITE_PARAM })
  @ApiJsonResponse(SuiteDraftViewSchema, {
    description: 'The open draft; 404 when there is none',
  })
  view(@Param('suite', folderPipe) folder: string): Promise<SuiteDraftView> {
    return this.drafts.view(folder);
  }

  @Patch(':suite/draft')
  @ApiParam({ name: 'suite', description: SUITE_PARAM })
  @ApiJsonBody(UpdateSuiteDraftRequestSchema, {
    description: 'Version label, description, task order',
  })
  @ApiJsonResponse(SuiteDraftViewSchema, { description: 'The draft after the change' })
  update(
    @Param('suite', folderPipe) folder: string,
    @Body(new ZodValidationPipe(UpdateSuiteDraftRequestSchema)) body: UpdateSuiteDraftRequest,
  ): Promise<SuiteDraftView> {
    return this.drafts.update(folder, body);
  }

  @Delete(':suite/draft')
  @HttpCode(204)
  @ApiParam({ name: 'suite', description: SUITE_PARAM })
  @ApiResponse({ status: 204, description: 'Discarded; nothing on disk changes' })
  async discard(@Param('suite', folderPipe) folder: string): Promise<void> {
    await this.drafts.discard(folder);
  }

  @Get(':suite/draft/review')
  @ApiParam({ name: 'suite', description: SUITE_PARAM })
  @ApiJsonResponse(DraftReviewSchema, { description: 'What Save writes and what it creates' })
  review(@Param('suite', folderPipe) folder: string): Promise<DraftReview> {
    return this.drafts.review(folder);
  }

  @Get(':suite/versions/:n/zip')
  @ApiParam({ name: 'suite', description: SUITE_PARAM })
  @ApiParam({ name: 'n', description: 'The version number' })
  @ApiFileResponse("The version's files as <suite>-v<n>.zip, streamed from the blob store", [
    'application/zip',
  ])
  async zip(
    @Param('suite', folderPipe) folder: string,
    @Param('n', versionPipe) n: number,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const zip = await versionZip(this.db, this.storage, folder, n);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const file = new StreamableFile(zip.stream, {
      type: 'application/zip',
      disposition: contentDisposition('attachment', zip.filename),
    });
    file.setErrorHandler(streamFailure);
    return file;
  }
}
