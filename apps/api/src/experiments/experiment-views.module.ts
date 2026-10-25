import { Module } from '@nestjs/common';
import { ExperimentsReadController } from './experiments-read.controller.js';
import { ExperimentEventsHub } from './sse/experiment-events.hub.js';
import { DbLiveSource, LIVE_SOURCE } from './sse/live-source.js';
import { ExperimentViewsService } from './views/experiment-views.service.js';

/**
 * GET /experiments, GET /experiments/:id and the SSE stream
 * GET /experiments/:id/events. Needs the global DatabaseModule (DB token)
 * and LoggerModule. Import it after the module whose controller serves
 * GET /experiments/new-options and /experiments/estimate: Express matches
 * routes in registration order, and `/experiments/:id` would answer those
 * paths with a 404.
 */
@Module({
  controllers: [ExperimentsReadController],
  providers: [
    ExperimentViewsService,
    ExperimentEventsHub,
    { provide: LIVE_SOURCE, useClass: DbLiveSource },
  ],
  exports: [ExperimentViewsService],
})
export class ExperimentViewsModule {}
