import { Global, Module } from '@nestjs/common';
import { DatabaseService } from './database.service.js';
import { DB, dbProvider } from './db.provider.js';
import { MigrationService } from './migration.service.js';

@Global()
@Module({
  providers: [DatabaseService, MigrationService, dbProvider],
  exports: [DatabaseService, MigrationService, DB],
})
export class DatabaseModule {}
