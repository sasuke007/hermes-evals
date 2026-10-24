import { Module } from '@nestjs/common';
import { ConfigurationReadsService } from './configuration-reads.service.js';
import { ConfigurationWritesService } from './configuration-writes.service.js';
import { ConfigurationsController } from './configurations.controller.js';
import { ConfigurationFormOptionsService } from './form-options.service.js';

/**
 * Configurations: versions, freeze and diff (plan section 6). Needs the
 * global DatabaseModule (DB token), ConfigModule (PRICES_FILE) and
 * LoggerModule. ConfigurationReadsService is exported for the experiment
 * pages, which show configuration versions too.
 */
@Module({
  controllers: [ConfigurationsController],
  providers: [
    ConfigurationReadsService,
    ConfigurationWritesService,
    ConfigurationFormOptionsService,
  ],
  exports: [ConfigurationReadsService],
})
export class ConfigurationsModule {}
