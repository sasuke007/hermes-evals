import { Body, Controller, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { ApiParam, ApiTags } from '@nestjs/swagger';
import {
  DraftConflictBodySchema,
  DraftSaveFailureBodySchema,
  DraftSaveResultSchema,
  DraftSelfCheckViewSchema,
  DraftTaskKeySchema,
  RebaseSuiteDraftRequestSchema,
  SaveSuiteDraftRequestSchema,
  SuiteDraftViewSchema,
  SuiteFolderSchema,
  type DraftSaveResult,
  type DraftSelfCheckView,
  type RebaseSuiteDraftRequest,
  type SaveSuiteDraftRequest,
  type SuiteDraftView,
} from '@hermes-evals/shared';
import { z } from 'zod';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { ApiJsonBody, ApiJsonResponse } from '../../openapi/decorators.js';
import { DraftJobsService } from './draft-jobs.service.js';

const SUITE_PARAM = 'The suite folder under SUITES_DIR, e.g. invoices-v1';
const folderPipe = new ZodValidationPipe(SuiteFolderSchema);
const keyPipe = new ZodValidationPipe(DraftTaskKeySchema);
/** POST …/save may come without a body: the same as `{}`. */
const SaveBody = z.preprocess((body) => body ?? {}, SaveSuiteDraftRequestSchema);

/**
 * The draft routes that need the worker, and the rebase (plan 4.6, 11):
 * a task's self-check, the save as the next version, and Combine onto a
 * newer version. `:suite` is the folder name.
 */
@ApiTags('suite drafts')
@Controller('suites')
export class DraftJobsController {
  constructor(@Inject(DraftJobsService) private readonly jobs: DraftJobsService) {}

  @Post(':suite/draft/tasks/:key/self-check')
  @HttpCode(200)
  @ApiParam({ name: 'suite', description: SUITE_PARAM })
  @ApiJsonResponse(DraftSelfCheckViewSchema, {
    description:
      "Runs the task's self-checks in the worker and records them; 503 without a live worker",
  })
  selfCheck(
    @Param('suite', folderPipe) folder: string,
    @Param('key', keyPipe) key: string,
  ): Promise<DraftSelfCheckView> {
    return this.jobs.selfCheck(folder, key);
  }

  @Post(':suite/draft/save')
  @HttpCode(200)
  @ApiParam({ name: 'suite', description: SUITE_PARAM })
  @ApiJsonBody(SaveSuiteDraftRequestSchema, {
    description: 'The label to save with, and the reviewed revision; may be left out',
    required: false,
  })
  @ApiJsonResponse(DraftSaveResultSchema, {
    description:
      'Saves the draft as the next version: 409 conflict, 422 not saved (nothing on disk changed), 503 no worker',
  })
  @ApiJsonResponse(DraftConflictBodySchema, {
    status: 409,
    description:
      'The folder changed on disk after the draft began: the new version and the tasks both sides changed',
  })
  @ApiJsonResponse(DraftSaveFailureBodySchema, {
    status: 422,
    description: "The staging folder failed the loader: the step and the loader's error",
  })
  save(
    @Param('suite', folderPipe) folder: string,
    @Body(new ZodValidationPipe(SaveBody)) body: SaveSuiteDraftRequest,
  ): Promise<DraftSaveResult> {
    return this.jobs.save(folder, body);
  }

  @Post(':suite/draft/rebase')
  @HttpCode(200)
  @ApiParam({ name: 'suite', description: SUITE_PARAM })
  @ApiJsonBody(RebaseSuiteDraftRequestSchema, {
    description: 'The version to combine onto, and a side per overlapping task',
  })
  @ApiJsonResponse(SuiteDraftViewSchema, {
    description: 'The draft based on the newer version; 409 when the folder moved again',
  })
  @ApiJsonResponse(DraftConflictBodySchema, {
    status: 409,
    description: 'The folder moved again since the conflict was read',
  })
  rebase(
    @Param('suite', folderPipe) folder: string,
    @Body(new ZodValidationPipe(RebaseSuiteDraftRequestSchema)) body: RebaseSuiteDraftRequest,
  ): Promise<SuiteDraftView> {
    return this.jobs.rebase(folder, body);
  }
}
