import { Injectable } from '@nestjs/common';
import { HealthResponseSchema, type HealthResponse } from '@hermes-evals/shared';
import { DatabaseService } from '../database/database.service.js';
import { MigrationService } from '../database/migration.service.js';
import { QueueService } from '../queue/queue.service.js';

export const API_VERSION = '0.1.0';

@Injectable()
export class HealthService {
  private readonly startedAt = Date.now();

  constructor(
    private readonly database: DatabaseService,
    private readonly migrations: MigrationService,
    private readonly queue: QueueService,
  ) {}

  async check(): Promise<HealthResponse> {
    const [database, queue] = await Promise.all([this.database.ping(), this.queue.ping()]);
    const migrations = this.migrations.status();
    const status = database === 'ok' && migrations === 'ok' && queue === 'ok' ? 'ok' : 'degraded';
    return HealthResponseSchema.parse({
      status,
      version: API_VERSION,
      uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000),
      checks: { database, migrations, queue },
      timestamp: new Date().toISOString(),
    });
  }
}
