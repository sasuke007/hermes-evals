import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  McpServerInputSchema,
  McpServerRowSchema,
  McpTestViewSchema,
  type McpServerInput,
  type McpServerRow,
  type McpTestView,
} from '@hermes-evals/shared';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { ApiJsonBody, ApiJsonResponse } from '../../openapi/decorators.js';
import { McpServersService } from './mcp-servers.service.js';
import { McpTestsService } from './mcp-tests.service.js';

const definitionPipe = new ZodValidationPipe<McpServerInput>(McpServerInputSchema);

/** MCP server definitions and their "Test start" (plan 5.3). Names only, never a secret value. */
@ApiTags('resources')
@Controller('resources/mcp-servers')
export class McpController {
  constructor(
    @Inject(McpServersService) private readonly servers: McpServersService,
    @Inject(McpTestsService) private readonly tests: McpTestsService,
  ) {}

  @Get()
  @ApiJsonResponse(McpServerRowSchema, {
    array: true,
    description: 'Every server with its latest version, usage and last test',
  })
  list(): Promise<McpServerRow[]> {
    return this.servers.list();
  }

  @Post()
  @ApiJsonBody(McpServerInputSchema)
  @ApiJsonResponse(McpServerRowSchema, {
    status: 201,
    description: 'The new server, at version 1, untested',
  })
  create(@Body(definitionPipe) input: McpServerInput): Promise<McpServerRow> {
    return this.servers.create(input);
  }

  /** Tests what the form holds, before it is saved. */
  @Post('test')
  @HttpCode(200)
  @ApiJsonBody(McpServerInputSchema)
  @ApiJsonResponse(McpTestViewSchema, {
    description:
      'Starts the definition in a throwaway trial container and lists its tools; stores nothing',
  })
  testUnsaved(@Body(definitionPipe) input: McpServerInput): Promise<McpTestView> {
    return this.tests.testUnsaved(input);
  }

  @Put(':id')
  @ApiJsonBody(McpServerInputSchema)
  @ApiJsonResponse(McpServerRowSchema, {
    description: 'The saved server: edited in place, or a new version if it was frozen',
  })
  update(
    @Param('id') id: string,
    @Body(definitionPipe) input: McpServerInput,
  ): Promise<McpServerRow> {
    return this.servers.update(id, input);
  }

  @Post(':id/test')
  @HttpCode(200)
  @ApiJsonResponse(McpTestViewSchema, {
    description: 'Tests the latest version and records the result on it',
  })
  testSaved(@Param('id') id: string): Promise<McpTestView> {
    return this.tests.testSaved(id);
  }
}
