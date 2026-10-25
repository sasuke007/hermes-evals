import { Controller, Get, Req, Res } from '@nestjs/common';
import { ApiServiceUnavailableResponse, ApiTags } from '@nestjs/swagger';
import { SystemEventSchema } from '@hermes-evals/shared';
import type { Request, Response } from 'express';
import { SseConnection } from '../../experiments/sse/sse-connection.js';
import { ApiEventStream } from '../../openapi/decorators.js';
import { SystemEventsHub } from './system-events.hub.js';

/** The app shell's live pill and the no-worker banner, pushed (plan 11, UI_FLOWS 4 and 5). */
@ApiTags('system')
@Controller('system')
export class SystemEventsController {
  constructor(private readonly hub: SystemEventsHub) {}

  /** `summary` on connect and every 5 s. 503 answers before the stream opens. */
  @Get('events')
  @ApiEventStream(
    SystemEventSchema,
    'The running summary and worker presence (GET /system/summary), on connect and every 5 s.',
  )
  @ApiServiceUnavailableResponse({ description: 'Too many live connections are open' })
  stream(@Req() req: Request, @Res() res: Response): void {
    this.hub.admit();
    const connection = SseConnection.open(req, res);
    connection.whenClosed(this.hub.subscribe(connection));
  }
}
