import { Module, type DynamicModule, type ModuleMetadata, type Type } from '@nestjs/common';
import { StorageModule } from '../../storage/storage.module.js';
import { DRAFT_IMPORT_PORT, type DraftImportPort } from './draft-import.port.js';
import { SuiteImportController } from './suite-import.controller.js';
import { SuiteImportService } from './suite-import.service.js';
import { SuiteImportStore } from './suite-import.store.js';
import { SuiteZipImports } from './suite-zip-imports.js';

/**
 * Validated suite zips and their tokens, without the routes. The drafts
 * module imports this to open a draft from a zip (POST /suites/drafts with
 * `from: zip`); the import routes import it too. Needs the global
 * DatabaseModule and ConfigModule that AppModule provides.
 */
@Module({
  imports: [StorageModule],
  providers: [SuiteImportStore, SuiteZipImports],
  exports: [SuiteZipImports],
})
export class SuiteZipModule {}

/** The drafts module, as the import routes reach it. */
export interface DraftsForImport {
  /** The module that provides `port` (and exports it). */
  imports: NonNullable<ModuleMetadata['imports']>;
  /** Its provider that implements DraftImportPort. */
  port: Type<DraftImportPort>;
}

/**
 * The import routes (plan 4.6, SA.9 and SA.10). The drafts they add to
 * belong to the drafts module, wired in by AppModule:
 * `SuiteImportModule.withDrafts({ imports: [SuiteDraftsModule], port: SuiteDraftsService })`.
 */
@Module({})
export class SuiteImportModule {
  static withDrafts(drafts: DraftsForImport): DynamicModule {
    return {
      module: SuiteImportModule,
      imports: [StorageModule, SuiteZipModule, ...drafts.imports],
      controllers: [SuiteImportController],
      providers: [SuiteImportService, { provide: DRAFT_IMPORT_PORT, useExisting: drafts.port }],
    };
  }
}
