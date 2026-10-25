import { Controller, Get, Param, Req, Res } from '@nestjs/common';
import { ApiNotFoundResponse, ApiServiceUnavailableResponse, ApiTags } from '@nestjs/swagger';
import {
  ExperimentDetailSchema,
  ExperimentEventSchema,
  ExperimentListRowSchema,
  type ExperimentDetail,
  type ExperimentListRow,
} from '@hermes-evals/shared';
import type { Request, Response } from 'express';
import { ApiEventStream, ApiJsonResponse } from '../openapi/decorators.js';
import { ExperimentEventsHub } from './sse/experiment-events.hub.js';
import { SseConnection } from './sse/sse-connection.js';
import { ExperimentViewsService, experimentNotFound } from './views/experiment-views.service.js';

/**
 * The experiment reads: the list, the detail with its Overview, and the live
 * stream (plan 11, UI_FLOWS 14). Launch, the controls and New experiment's
 * options and estimate are in the commands controller; its static paths
 * (`/experiments/new-options`, `/experiments/estimate`) must be registered
 * before this controller's `/experiments/:id`.
 */
@ApiTags('experiments')
@Controller('experiments')
export class ExperimentsReadController {
  constructor(
    private readonly views: ExperimentViewsService,
    private readonly events: ExperimentEventsHub,
  ) {}

  @Get()
  @ApiJsonResponse(ExperimentListRowSchema, {
    array: true,
    description: 'Every experiment, newest first',
  })
  list(): Promise<ExperimentListRow[]> {
    return this.views.list();
  }

  @Get(':id')
  @ApiJsonResponse(ExperimentDetailSchema, {
    description: 'Header, frozen snapshot, progress, spend, feed, aggregates and failure',
  })
  @ApiNotFoundResponse({ description: 'No experiment with this id' })
  detail(@Param('id') id: string): Promise<ExperimentDetail> {
    return this.views.detail(id);
  }

  /**
   * Live updates of one experiment: `experiment` and `counts` on connect,
   * then `run`, `feed`, `counts` and `experiment` events as they happen.
   * 404 and 503 answer before the stream opens.
   */
  @Get(':id/events')
  @ApiEventStream(
    ExperimentEventSchema,
    'Events of one experiment: run, feed, counts and experiment (polled from Postgres every second).',
  )
  @ApiNotFoundResponse({ description: 'No experiment with this id' })
  @ApiServiceUnavailableResponse({ description: 'Too many live connections are open' })
  async stream(@Param('id') id: string, @Req() req: Request, @Res() res: Response): Promise<void> {
    if (!(await this.events.exists(id))) throw experimentNotFound(id);
    // No await between the cap check and subscribe, so two requests cannot both take the last place.
    this.events.admit();
    const connection = SseConnection.open(req, res);
    connection.whenClosed(this.events.subscribe(id, connection));
  }
}
