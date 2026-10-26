import { Module } from '@nestjs/common';
import { StorageModule } from '../../storage/storage.module.js';
import { SuiteZipModule } from '../import/suite-import.module.js';
import { DraftFilesService } from './draft-files.service.js';
import { DraftTasksController } from './draft-tasks.controller.js';
import { DraftTasksService } from './draft-tasks.service.js';
import { SuiteDraftsController } from './drafts.controller.js';
import { SuiteDraftsService } from './drafts.service.js';

/**
 * Suite drafts (plan 4.6, Phase 5b): the draft API, its readiness rules and
 * the version download. Needs the global DatabaseModule and ConfigModule
 * that AppModule provides. AppModule imports it before SuitesModule, so
 * GET /suites/drafts is routed here rather than to GET /suites/:id.
 *
 * Exports SuiteDraftsService (the imports' DraftImportPort) and
 * DraftTasksService. A draft from a zip takes the validated zips of
 * SuiteZipModule, which holds them without the import routes.
 */
@Module({
  imports: [StorageModule, SuiteZipModule],
  controllers: [SuiteDraftsController, DraftTasksController],
  providers: [SuiteDraftsService, DraftTasksService, DraftFilesService],
  exports: [SuiteDraftsService, DraftTasksService],
})
export class SuiteDraftsModule {}
