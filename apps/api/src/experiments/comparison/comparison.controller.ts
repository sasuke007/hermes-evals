import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBadRequestResponse, ApiNotFoundResponse, ApiQuery, ApiTags } from '@nestjs/swagger';
import {
  COMPARISON_FILTERS,
  ComparisonQuerySchema,
  ComparisonViewSchema,
  type ComparisonQuery,
  type ComparisonView,
} from '@hermes-evals/shared';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { ApiJsonResponse } from '../../openapi/decorators.js';
import { ComparisonService } from './comparison.service.js';

/**
 * The Comparison tab (plan 10.3, UI_FLOWS 16): one candidate against the
 * baseline. Two path segments after /experiments, so it never meets the
 * Phase 2 routes `/experiments/:id` and `/experiments/new-options`, whatever
 * order the controllers register in.
 */
@ApiTags('experiments')
@Controller('experiments')
export class ComparisonController {
  constructor(private readonly comparisons: ComparisonService) {}

  @Get(':id/comparison')
  @ApiQuery({
    name: 'candidate',
    required: false,
    description: 'Candidate configuration version id; the first candidate by default',
  })
  @ApiQuery({
    name: 'key',
    required: false,
    description: '`primary` (default), `any_failed`, or a key every selected task declares',
  })
  @ApiQuery({ name: 'filter', required: false, enum: COMPARISON_FILTERS })
  @ApiJsonResponse(ComparisonViewSchema, {
    description:
      'The task grid, per-task rates and changes, the statistics or why there are none, the sensitivity figure, secondary metrics and progress',
  })
  @ApiBadRequestResponse({
    description:
      'An unknown filter, a candidate the experiment does not test, or a key some task lacks',
  })
  @ApiNotFoundResponse({ description: 'No experiment with this id' })
  async comparison(
    @Param('id') id: string,
    @Query(new ZodValidationPipe(ComparisonQuerySchema)) query: ComparisonQuery,
  ): Promise<ComparisonView> {
    return ComparisonViewSchema.parse(await this.comparisons.comparison(id, query));
  }
}
