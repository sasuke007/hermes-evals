/**
 * Experiment commands (plan 7.1 to 7.3 and 11, UI_FLOWS 11 and 15): the New
 * experiment options and estimate, launch, the controls and Duplicate.
 * Request bodies and queries are checked with the shared schemas, and every
 * answer is parsed with its shared contract on the way out. The reads of an
 * experiment (list, detail, events) live in the experiment views.
 *
 * `new-options` and `estimate` are literal paths: the module mounting this
 * controller must come before any controller with `GET /experiments/:id`, or
 * Express would read them as ids.
 */
import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiQuery, ApiTags } from '@nestjs/swagger';
import {
  EstimateQuerySchema,
  ExperimentActionResultSchema,
  ExperimentEstimateViewSchema,
  LaunchExperimentInputSchema,
  LaunchExperimentResultSchema,
  NewExperimentDraftSchema,
  NewExperimentOptionsSchema,
  ResumeExperimentInputSchema,
  type EstimateQuery,
  type ExperimentActionResult,
  type ExperimentEstimateView,
  type LaunchExperimentInput,
  type LaunchExperimentResult,
  type NewExperimentDraft,
  type NewExperimentOptions,
  type ResumeExperimentInput,
} from '@hermes-evals/shared';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { ApiJsonBody, ApiJsonResponse } from '../../openapi/decorators.js';
import { EstimatesService } from '../estimates/estimates.service.js';
import { ExperimentControlsService } from './controls.service.js';
import { DuplicateService } from './duplicate.service.js';
import { LaunchService } from './launch.service.js';
import { NewOptionsService } from './new-options.service.js';

const ACTION_REFUSED =
  'Answers 409 with the reason when the experiment is not in a state this applies to.';

@ApiTags('experiments')
@Controller('experiments')
export class ExperimentsCommandsController {
  constructor(
    private readonly launches: LaunchService,
    private readonly options: NewOptionsService,
    private readonly estimates: EstimatesService,
    private readonly controls: ExperimentControlsService,
    private readonly duplicates: DuplicateService,
  ) {}

  @Get('new-options')
  @ApiJsonResponse(NewExperimentOptionsSchema, {
    description: 'Suites, configurations with per-run estimates, defaults, concurrency and prices',
  })
  async newOptions(): Promise<NewExperimentOptions> {
    return NewExperimentOptionsSchema.parse(await this.options.options());
  }

  @Get('estimate')
  @ApiQuery({ name: 'suite', type: String, required: true, description: 'Suite version id' })
  @ApiQuery({
    name: 'versions',
    type: String,
    required: true,
    description: 'Configuration version ids, comma-separated',
  })
  @ApiQuery({ name: 'tasks', type: Number, required: true, description: 'Selected task count' })
  @ApiQuery({ name: 'repetitions', type: Number, required: true })
  @ApiQuery({ name: 'concurrency', type: Number, required: true })
  @ApiJsonResponse(ExperimentEstimateViewSchema, {
    description: 'Runs, waves, duration and cost; history medians or the budget fallback',
  })
  async estimate(
    @Query(new ZodValidationPipe(EstimateQuerySchema)) query: EstimateQuery,
  ): Promise<ExperimentEstimateView> {
    return ExperimentEstimateViewSchema.parse(await this.estimates.estimate(query));
  }

  @Post()
  @ApiJsonBody(LaunchExperimentInputSchema)
  @ApiJsonResponse(LaunchExperimentResultSchema, {
    status: 201,
    description:
      'Launches: freezes the versions, inserts the experiment and its runs and sends their jobs in one transaction. 409 when no proven worker is connected, workers disagree on Hermes, a provider is not ready, or a configuration changed.',
  })
  async launch(
    @Body(new ZodValidationPipe(LaunchExperimentInputSchema)) input: LaunchExperimentInput,
  ): Promise<LaunchExperimentResult> {
    return LaunchExperimentResultSchema.parse(await this.launches.launch(input));
  }

  @Post(':id/pause')
  @HttpCode(200)
  @ApiJsonResponse(ExperimentActionResultSchema, {
    description: `Pauses: nothing new starts, in-flight runs finish. ${ACTION_REFUSED}`,
  })
  async pause(@Param('id') id: string): Promise<ExperimentActionResult> {
    return ExperimentActionResultSchema.parse(await this.controls.pause(id));
  }

  @Post(':id/resume')
  @HttpCode(200)
  @ApiJsonBody(ResumeExperimentInputSchema, { required: false })
  @ApiJsonResponse(ExperimentActionResultSchema, {
    description: `Resumes and re-sends the queued runs; a spend-ceiling pause needs a higher spendCeilingUsd, a provider pause the provider ready. ${ACTION_REFUSED}`,
  })
  async resume(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(ResumeExperimentInputSchema)) input: ResumeExperimentInput,
  ): Promise<ExperimentActionResult> {
    return ExperimentActionResultSchema.parse(await this.controls.resume(id, input));
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @ApiJsonResponse(ExperimentActionResultSchema, {
    description: `Cancels: queued runs are cancelled, running ones stopped, scored ones kept. ${ACTION_REFUSED}`,
  })
  async cancel(@Param('id') id: string): Promise<ExperimentActionResult> {
    return ExperimentActionResultSchema.parse(await this.controls.cancel(id));
  }

  @Post(':id/retry-failed')
  @HttpCode(200)
  @ApiJsonResponse(ExperimentActionResultSchema, {
    description: `Reopens a failed experiment: clears the failure and re-queues its errored runs. ${ACTION_REFUSED}`,
  })
  async retryFailed(@Param('id') id: string): Promise<ExperimentActionResult> {
    return ExperimentActionResultSchema.parse(await this.controls.retryFailed(id));
  }

  /** Stores nothing, so 200 rather than 201. */
  @Post(':id/duplicate')
  @HttpCode(200)
  @ApiJsonResponse(NewExperimentDraftSchema, {
    description:
      "A prefilled New experiment form on the suite's current version; nothing is stored",
  })
  async duplicate(@Param('id') id: string): Promise<NewExperimentDraft> {
    return NewExperimentDraftSchema.parse(await this.duplicates.duplicate(id));
  }
}
