import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiTags } from '@nestjs/swagger';
import { SystemSetupSchema, type SystemSetup } from '@hermes-evals/shared';
import type { Env } from '../config/env.js';
import { ApiJsonResponse } from '../openapi/decorators.js';
import { judgeViewFrom } from '../providers/judge-view.js';
import { SeedReporter } from './seed-report.js';

/**
 * GET /system/setup (Phase 8 G2, G3): the API's own settings that decide
 * what a fresh clone can do, for System: the platform judge, and whether it
 * is the mock model, and this start's samples seed. Beside SystemController,
 * which owns the rest of /system: the seed's report lives here.
 */
@ApiTags('system')
@Controller('system')
export class SetupController {
  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly reporter: SeedReporter,
  ) {}

  @Get('setup')
  @ApiJsonResponse(SystemSetupSchema, {
    description: "The LLM judge (and whether it is the mock model) and the samples seed's report",
  })
  setup(): SystemSetup {
    return { judge: judgeViewFrom(this.config), seed: this.reporter.report() };
  }
}
