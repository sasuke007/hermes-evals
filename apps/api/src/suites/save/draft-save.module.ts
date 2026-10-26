import { Module } from '@nestjs/common';
import { StorageModule } from '../../storage/storage.module.js';
import { DraftJobsController } from './draft-jobs.controller.js';
import { DraftJobsService } from './draft-jobs.service.js';

/**
 * The API's side of the draft jobs (plan 4.6, Phase 5b): a draft task's
 * self-check and the save, which the worker runs, and the rebase. Needs the
 * global DatabaseModule, QueueModule and ConfigModule that AppModule
 * provides. The worker side is registered by WorkerService
 * (worker/handlers/draft-jobs.ts).
 */
@Module({
  imports: [StorageModule],
  controllers: [DraftJobsController],
  providers: [DraftJobsService],
})
export class DraftSaveModule {}
