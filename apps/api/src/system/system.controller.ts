import { Controller, Get } from '@nestjs/common';
import { ApiNotFoundResponse, ApiTags } from '@nestjs/swagger';
import {
  SandboxStatusSchema,
  SystemSummarySchema,
  WorkerSchema,
  type SandboxStatus,
  type SystemSummary,
  type Worker,
} from '@hermes-evals/shared';
import { ApiJsonResponse } from '../openapi/decorators.js';
import { SystemService } from './system.service.js';

/** Worker presence, the running summary and the isolation proof (plan section 11). */
@ApiTags('system')
@Controller('system')
export class SystemController {
  constructor(private readonly system: SystemService) {}

  @Get('summary')
  @ApiJsonResponse(SystemSummarySchema, {
    description: 'Running experiments, workers and queued runs',
  })
  summary(): Promise<SystemSummary> {
    return this.system.summary();
  }

  @Get('workers')
  @ApiJsonResponse(WorkerSchema, {
    array: true,
    description: 'Workers with heartbeat, concurrency and sandbox proof',
  })
  workers(): Promise<Worker[]> {
    return this.system.workers();
  }

  @Get('sandbox')
  @ApiJsonResponse(SandboxStatusSchema, { description: "The live worker's isolation self-test" })
  @ApiNotFoundResponse({ description: 'No live worker, or it has not reported a self-test' })
  sandbox(): Promise<SandboxStatus> {
    return this.system.sandbox();
  }
}
