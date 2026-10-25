import { Module } from '@nestjs/common';
import { ExperimentCommandsModule } from '../../experiments/commands/experiment-commands.module.js';
import { RunCommandsService } from './run-commands.service.js';
import { RunsCommandsController } from './runs-commands.controller.js';

/**
 * Run commands: Retry, Cancel and bulk Retry execution (plan 7.3, UI_FLOWS
 * 17 and 18). Re-score is Phase 3. Uses ExperimentCommandsModule's
 * ProviderGate, so the same provider rule applies; needs the same global
 * modules as it does.
 */
@Module({
  imports: [ExperimentCommandsModule],
  controllers: [RunsCommandsController],
  providers: [RunCommandsService],
})
export class RunCommandsModule {}
