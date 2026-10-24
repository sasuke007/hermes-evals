import { Module } from '@nestjs/common';
import { StorageModule } from '../../storage/storage.module.js';
import { DocumentsController } from './documents.controller.js';
import { DocumentsService } from './documents.service.js';

/**
 * Document uploads and downloads (plan 5.2). Needs DatabaseModule (DB),
 * ConfigModule and LoggerModule from the app; imports StorageModule itself.
 */
@Module({
  imports: [StorageModule],
  controllers: [DocumentsController],
  providers: [DocumentsService],
  exports: [DocumentsService],
})
export class DocumentsModule {}
