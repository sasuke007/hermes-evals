import { Module } from '@nestjs/common';
import { ConfigurationWritesService } from '../configurations/configuration-writes.service.js';
import { DocumentsModule } from '../resources/documents/documents.module.js';
import { McpModule } from '../resources/mcp/mcp.module.js';
import { SkillsModule } from '../resources/skills/skills.module.js';
import { SampleSeedService } from './seed.service.js';
import { SeedReporter } from './seed-report.js';
import { SetupController } from './setup.controller.js';

/**
 * The samples a fresh clone starts with (Phase 8 G3) and GET /system/setup.
 * The seed saves through the services the pages use: SkillsService,
 * DocumentsService and McpServersService from their modules, and its own
 * ConfigurationWritesService, which holds no state beyond the database
 * (ConfigurationsModule does not export it). Needs the global
 * DatabaseModule, StorageModule, ConfigModule and LoggerModule.
 */
@Module({
  imports: [SkillsModule, DocumentsModule, McpModule],
  controllers: [SetupController],
  providers: [SeedReporter, SampleSeedService, ConfigurationWritesService],
})
export class SamplesModule {}
