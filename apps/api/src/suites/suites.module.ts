import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module.js';
import { SuiteReloadService } from './suite-reload.service.js';
import { SuiteTasksService } from './suite-tasks.service.js';
import { SuitesController } from './suites.controller.js';
import { SuitesService } from './suites.service.js';

/**
 * The suites API: read endpoints over the loaded suites and POST
 * /suites/reload, which hands the load to the worker. Needs the global
 * DatabaseModule, QueueModule and ConfigModule that AppModule provides;
 * imports StorageModule itself (fixtures are read from the blob store).
 */
@Module({
  imports: [StorageModule],
  controllers: [SuitesController],
  providers: [SuitesService, SuiteTasksService, SuiteReloadService],
  exports: [SuitesService, SuiteTasksService],
})
export class SuitesModule {}
