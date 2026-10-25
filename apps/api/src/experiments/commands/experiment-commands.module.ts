import { Module } from '@nestjs/common';
import { EstimatesService } from '../estimates/estimates.service.js';
import { ExperimentControlsService } from './controls.service.js';
import { DuplicateService } from './duplicate.service.js';
import { ExperimentsCommandsController } from './experiments-commands.controller.js';
import { LaunchService } from './launch.service.js';
import { NewOptionsService } from './new-options.service.js';
import { ProviderGate } from './provider-gate.js';

/**
 * Experiment commands: New experiment options and estimate, launch, the
 * controls and Duplicate (plan 7.1 to 7.3). Needs the global DatabaseModule
 * (DB), QueueModule (pg-boss), ConfigModule (PRICES_FILE) and LoggerModule,
 * and a global provider of PROVIDER_READINESS_DEPS (provider-gate.ts).
 *
 * Import it before any module whose controller serves GET /experiments/:id:
 * this controller's literal GET paths (new-options, estimate) must be
 * registered first. ProviderGate and EstimatesService are exported for the
 * run commands and anything else that needs the same rules.
 */
@Module({
  controllers: [ExperimentsCommandsController],
  providers: [
    ProviderGate,
    EstimatesService,
    LaunchService,
    NewOptionsService,
    ExperimentControlsService,
    DuplicateService,
  ],
  exports: [ProviderGate, EstimatesService],
})
export class ExperimentCommandsModule {}
