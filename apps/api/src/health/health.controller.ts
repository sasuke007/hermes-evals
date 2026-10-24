import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { HealthResponseSchema, type HealthResponse } from '@hermes-evals/shared';
import { ApiJsonResponse } from '../openapi/decorators.js';
import { HealthService } from './health.service.js';

@ApiTags('system')
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get()
  @ApiJsonResponse(HealthResponseSchema, { description: 'Liveness plus dependency checks' })
  get(): Promise<HealthResponse> {
    return this.health.check();
  }
}
