import { Global, Module } from '@nestjs/common';
import { DatabaseService } from './database.service.js';
import { MigrationService } from './migration.service.js';

@Global()
@Module({
  providers: [DatabaseService, MigrationService],
  exports: [DatabaseService, MigrationService],
})
export class DatabaseModule {}
