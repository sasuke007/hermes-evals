import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';
import { PgBoss } from 'pg-boss';
import type { Env } from '../config/env.js';
import { isConnectionError } from '../database/migration.service.js';
import { QUEUE_DEFINITIONS, type QueueDefinition } from './queues.js';

/**
 * Applies the queue definitions: creates missing queues and re-applies every
 * changeable option to existing ones (createQueue alone leaves an existing
 * queue untouched). Policy and partitioning cannot change after creation, so
 * a mismatch stops startup instead of running with the wrong semantics.
 * Safe to run from the API and the worker at the same time.
 */
export async function ensureQueues(
  boss: PgBoss,
  definitions: readonly QueueDefinition[] = QUEUE_DEFINITIONS,
): Promise<void> {
  for (const { name, options } of definitions) {
    await boss.createQueue(name, options);
    const { policy, partition, ...changeable } = options;
    if (Object.keys(changeable).length > 0) await boss.updateQueue(name, changeable);
    const queue = await boss.getQueue(name);
    const expectedPolicy = policy ?? 'standard';
    if (
      !queue ||
      queue.policy !== expectedPolicy ||
      Boolean(queue.partition) !== Boolean(partition)
    ) {
      throw new Error(
        `queue ${name} exists with policy ${queue?.policy ?? 'none'}, expected ${expectedPolicy}; ` +
          'delete the queue or reset the database volume',
      );
    }
  }
}

/**
 * Thin wrapper over pg-boss. Durable jobs live in Postgres, in the `pgboss`
 * schema next to our tables, so the API and the worker share one queue
 * without Redis and can enqueue inside their own transactions.
 * Starts only when DATABASE_URL is set.
 */
@Injectable()
export class QueueService implements OnModuleInit, OnModuleDestroy {
  private boss: PgBoss | null = null;
  private state: 'ok' | 'unavailable' | 'not_configured' = 'not_configured';

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(QueueService.name);
  }

  async onModuleInit(): Promise<void> {
    const url = this.config.get('DATABASE_URL', { infer: true });
    if (!url) return;
    const boss = new PgBoss({ connectionString: url, schema: 'pgboss' });
    boss.on('error', (err: Error) => this.logger.error({ err }, 'pg-boss error'));
    try {
      await boss.start();
    } catch (err) {
      // Only an unreachable database degrades; anything else is a fault.
      if (!isConnectionError(err)) throw err;
      this.state = 'unavailable';
      this.logger.warn({ err }, 'pg-boss could not start; queue unavailable');
      return;
    }
    // A wrong queue policy is a deployment fault, not an outage: stop startup.
    await ensureQueues(boss);
    this.boss = boss;
    this.state = 'ok';
    this.logger.info('pg-boss started');
  }

  get instance(): PgBoss {
    if (!this.boss) throw new Error('Queue is not available');
    return this.boss;
  }

  async ping(): Promise<'ok' | 'unavailable' | 'not_configured'> {
    return this.state;
  }

  async onModuleDestroy(): Promise<void> {
    await this.boss?.stop({ graceful: true, timeout: 5000 });
  }
}
