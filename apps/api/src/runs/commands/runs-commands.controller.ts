/**
 * Run commands (plan 11, UI_FLOWS 17 and 18): Re-score, Retry and Cancel
 * from the inspector, and bulk Re-score and Retry execution from the Runs
 * tab. Bodies are checked with the shared schemas, and every answer is
 * parsed with its shared contract on the way out.
 */
import { Body, Controller, HttpCode, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  BulkRescoreResultSchema,
  BulkRunActionInputSchema,
  BulkRunActionResultSchema,
  RescoreRunResultSchema,
  RunActionResultSchema,
  type BulkRescoreResult,
  type BulkRunActionInput,
  type BulkRunActionResult,
  type RescoreRunResult,
  type RunActionResult,
} from '@hermes-evals/shared';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { ApiJsonBody, ApiJsonResponse } from '../../openapi/decorators.js';
import { RescoreService } from './rescore.service.js';
import { RunCommandsService } from './run-commands.service.js';

@ApiTags('runs')
@Controller()
export class RunsCommandsController {
  constructor(
    private readonly commands: RunCommandsService,
    private readonly rescores: RescoreService,
  ) {}

  @Post('runs/:id/rescore')
  @HttpCode(200)
  @ApiJsonResponse(RescoreRunResultSchema, {
    description:
      'Queues a re-score of a scored run: a new evaluation generation graded from the stored evidence, never re-executed (a RescoreRunResult: the run stays scored, with `evaluation` and `joinedPending`). A re-score already queued or running is answered as is. 409 when the run is not scored, or a task llm_judge key needs a judge provider that is not ready.',
  })
  async rescore(@Param('id') id: string): Promise<RescoreRunResult> {
    return RescoreRunResultSchema.parse(await this.rescores.rescore(id));
  }

  @Post('runs/:id/retry')
  @HttpCode(200)
  @ApiJsonResponse(RunActionResultSchema, {
    description:
      'Queues an execution_error run for its next attempt (at most 5). 409 with the reason otherwise, or when its provider is not ready.',
  })
  async retry(@Param('id') id: string): Promise<RunActionResult> {
    return RunActionResultSchema.parse(await this.commands.retry(id));
  }

  @Post('runs/:id/cancel')
  @HttpCode(200)
  @ApiJsonResponse(RunActionResultSchema, {
    description:
      'Cancels a queued run, or asks the worker to stop a running one (status stays running until it has). 409 for any other status.',
  })
  async cancel(@Param('id') id: string): Promise<RunActionResult> {
    return RunActionResultSchema.parse(await this.commands.cancel(id));
  }

  @Post('experiments/:id/runs/retry')
  @HttpCode(200)
  @ApiJsonBody(BulkRunActionInputSchema)
  @ApiJsonResponse(BulkRunActionResultSchema, {
    description:
      'Retries every listed run that can be retried; the others are refused with their reason',
  })
  async retryMany(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(BulkRunActionInputSchema)) input: BulkRunActionInput,
  ): Promise<BulkRunActionResult> {
    return BulkRunActionResultSchema.parse(await this.commands.retryMany(id, input.runIds));
  }

  @Post('experiments/:id/runs/rescore')
  @HttpCode(200)
  @ApiJsonBody(BulkRunActionInputSchema)
  @ApiJsonResponse(BulkRescoreResultSchema, {
    description:
      'Re-scores every listed scored run, or joins its pending re-score; the others are refused with their reason (a BulkRescoreResult, with each accepted run’s `evaluations` entry in `enqueued` order)',
  })
  async rescoreMany(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(BulkRunActionInputSchema)) input: BulkRunActionInput,
  ): Promise<BulkRescoreResult> {
    return BulkRescoreResultSchema.parse(await this.rescores.rescoreMany(id, input.runIds));
  }
}
