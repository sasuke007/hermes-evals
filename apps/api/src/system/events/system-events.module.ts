import { Module } from '@nestjs/common';
import { SystemModule } from '../system.module.js';
import { SystemEventsController } from './system-events.controller.js';
import { SystemEventsHub } from './system-events.hub.js';

/**
 * GET /system/events (SSE). Reads through SystemModule's SystemService, so it
 * needs the global DatabaseModule and LoggerModule like SystemModule does.
 */
@Module({
  imports: [SystemModule],
  controllers: [SystemEventsController],
  providers: [SystemEventsHub],
})
export class SystemEventsModule {}
