import { Global, Module } from '@nestjs/common';
import { ComparisonController } from './comparison.controller.js';
import { ComparisonService } from './comparison.service.js';

/**
 * GET /experiments/:id/comparison and the ComparisonService with its cache.
 * Global, so the experiment views and the live stream share the one cache
 * (their services take it as an optional dependency). Needs the global
 * DatabaseModule (DB token).
 */
@Global()
@Module({
  controllers: [ComparisonController],
  providers: [ComparisonService],
  exports: [ComparisonService],
})
export class ComparisonModule {}
