/**
 * Run commands (plan 11, UI_FLOWS 17 and 18): Retry and Cancel from the
 * inspector, and bulk Retry execution from the Runs tab. Re-score routes
 * belong to Phase 3. Bodies are checked with the shared schemas, and every
 * answer is parsed with its shared contract on the way out.
 */
import { Body, Controller, HttpCode, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  BulkRunActionInputSchema,
  BulkRunActionResultSchema,
  RunActionResultSchema,
  type BulkRunActionInput,
  type BulkRunActionResult,
  type RunActionResult,
} from '@hermes-evals/shared';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { ApiJsonBody, ApiJsonResponse } from '../../openapi/decorators.js';
import { RunCommandsService } from './run-commands.service.js';

@ApiTags('runs')
@Controller()
export class RunsCommandsController {
  constructor(private readonly commands: RunCommandsService) {}

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
}
