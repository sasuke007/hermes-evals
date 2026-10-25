import { Module } from '@nestjs/common';
import { RunsReadController } from './runs-read.controller.js';
import { RunViewsService } from './run-views.service.js';

/**
 * GET /experiments/:id/runs, GET /runs/:id, GET /runs/:id/events and the
 * artifact content and preview routes (plan 11, UI_FLOWS 17 and 18).
 * Needs DatabaseModule, StorageModule and ConfigModule, which are global.
 */
@Module({
  controllers: [RunsReadController],
  providers: [RunViewsService],
  exports: [RunViewsService],
})
export class RunViewsModule {}
