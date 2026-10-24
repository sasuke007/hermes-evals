import { Controller, Get, Inject } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ResourceCountsSchema, type ResourceCounts } from '@hermes-evals/shared';
import { ApiJsonResponse } from '../../openapi/decorators.js';
import { CountsService } from './counts.service.js';

@ApiTags('resources')
@Controller('resources/counts')
export class CountsController {
  constructor(@Inject(CountsService) private readonly counts: CountsService) {}

  @Get()
  @ApiJsonResponse(ResourceCountsSchema, {
    description: 'How many skills, documents, MCP servers and secrets each tab lists',
  })
  get(): Promise<ResourceCounts> {
    return this.counts.counts();
  }
}
