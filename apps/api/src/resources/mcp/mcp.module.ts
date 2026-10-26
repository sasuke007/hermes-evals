import { Module } from '@nestjs/common';
import { McpController } from './mcp.controller.js';
import { McpServersService } from './mcp-servers.service.js';
import { McpTestsService } from './mcp-tests.service.js';
import { UnsavedMcpTests } from './unsaved-tests.js';

/**
 * /resources/mcp-servers. Needs the global DatabaseModule (DB), QueueModule
 * and ConfigModule.
 */
@Module({
  controllers: [McpController],
  providers: [McpServersService, McpTestsService, UnsavedMcpTests],
  exports: [McpServersService],
})
export class McpModule {}
