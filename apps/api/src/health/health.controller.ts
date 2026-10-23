import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { HealthResponse } from '@hermes-evals/shared';
import { HealthService } from './health.service.js';

@ApiTags('system')
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get()
  @ApiOkResponse({ description: 'Liveness plus dependency checks' })
  get(): Promise<HealthResponse> {
    return this.health.check();
  }
}
