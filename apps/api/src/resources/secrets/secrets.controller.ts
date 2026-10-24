import { Controller, Get, Inject, Query } from '@nestjs/common';
import { ApiQuery, ApiTags } from '@nestjs/swagger';
import { SecretRowSchema, type SecretRow } from '@hermes-evals/shared';
import { ApiJsonResponse } from '../../openapi/decorators.js';
import { SecretsService } from './secrets.service.js';

/** Secret names and whether they are set. A value is never stored, typed or sent (plan 5.3). */
@ApiTags('resources')
@Controller('resources/secrets')
export class SecretsController {
  constructor(@Inject(SecretsService) private readonly secrets: SecretsService) {}

  /**
   * `refresh` (the page sends `refresh=true`) is its "Check again". The
   * worker re-reads its own and egress's env names on every heartbeat (10 s),
   * so every request already reads the latest report; the flag is accepted
   * and needs nothing more.
   */
  @Get()
  @ApiQuery({
    name: 'refresh',
    required: false,
    description: 'Any value: re-read the latest worker report',
  })
  @ApiJsonResponse(SecretRowSchema, {
    array: true,
    description: 'One row per referenced name and the service that reads it',
  })
  list(@Query('refresh') _refresh?: string): Promise<SecretRow[]> {
    return this.secrets.list();
  }
}
