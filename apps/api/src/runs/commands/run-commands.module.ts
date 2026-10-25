import { Module } from '@nestjs/common';
import { ExperimentCommandsModule } from '../../experiments/commands/experiment-commands.module.js';
import { RescoreService } from './rescore.service.js';
import { RunCommandsService } from './run-commands.service.js';
import { RunsCommandsController } from './runs-commands.controller.js';

/**
 * Run commands: Re-score, Retry, Cancel, and the bulk Re-score and Retry
 * execution (plan 7.3, 9.4, UI_FLOWS 17 and 18). Uses
 * ExperimentCommandsModule's ProviderGate, so the same provider rule applies
 * to a run's provider and to the judge's; needs the same global modules as
 * it does, and ConfigService for the judge settings.
 */
@Module({
  imports: [ExperimentCommandsModule],
  controllers: [RunsCommandsController],
  providers: [RunCommandsService, RescoreService],
})
export class RunCommandsModule {}
