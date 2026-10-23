import { describe, expect, it } from 'vitest';
import { HealthService } from './health.service.js';
import type { DatabaseService } from '../database/database.service.js';
import type { MigrationService } from '../database/migration.service.js';
import type { QueueService } from '../queue/queue.service.js';

type Check = 'ok' | 'unavailable' | 'not_configured';

const fake = (db: Check, migrations: Check, q: Check) =>
  new HealthService(
    { ping: async () => db } as unknown as DatabaseService,
    { status: () => migrations } as unknown as MigrationService,
    { ping: async () => q } as unknown as QueueService,
  );

describe('HealthService', () => {
  it('reports ok only when database, migrations and queue are all ok', async () => {
    expect((await fake('ok', 'ok', 'ok').check()).status).toBe('ok');
    expect((await fake('not_configured', 'not_configured', 'not_configured').check()).status).toBe(
      'degraded',
    );
    expect((await fake('ok', 'unavailable', 'ok').check()).status).toBe('degraded');
    expect((await fake('ok', 'ok', 'unavailable').check()).status).toBe('degraded');
  });

  it('returns a payload that satisfies the shared schema', async () => {
    const res = await fake('ok', 'ok', 'ok').check();
    expect(res.version).toBe('0.1.0');
    expect(typeof res.timestamp).toBe('string');
    expect(res.checks).toEqual({ database: 'ok', migrations: 'ok', queue: 'ok' });
  });
});
