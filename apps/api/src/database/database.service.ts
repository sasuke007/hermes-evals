import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { PinoLogger } from 'nestjs-pino';
import type { Env } from '../config/env.js';
import * as schema from './schema/index.js';

export type Db = NodePgDatabase<typeof schema>;

/**
 * Owns the Postgres pool and the Drizzle client. The pool is created lazily
 * from DATABASE_URL so the API can still start, and report the database as
 * unavailable, when Postgres is down or not configured.
 */
@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private pool: pg.Pool | null = null;
  private client: Db | null = null;

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(DatabaseService.name);
  }

  get isConfigured(): boolean {
    return Boolean(this.config.get('DATABASE_URL', { infer: true }));
  }

  get db(): Db {
    if (!this.client) {
      const url = this.config.get('DATABASE_URL', { infer: true });
      if (!url) throw new Error('DATABASE_URL is not set');
      this.pool = new pg.Pool({ connectionString: url, max: 10 });
      // An idle client whose server went away (a Postgres restart answers 57P01) emits
      // 'error' on the pool; unhandled, that event would end the API or the worker. The
      // pool drops that client and the next query connects afresh.
      this.pool.on('error', (err) => this.logger.warn({ err }, 'idle database client failed'));
      this.client = drizzle(this.pool, { schema });
    }
    return this.client;
  }

  async ping(): Promise<'ok' | 'unavailable' | 'not_configured'> {
    if (!this.isConfigured) return 'not_configured';
    try {
      await this.db.execute(sql`select 1`);
      return 'ok';
    } catch (err) {
      this.logger.warn({ err }, 'database ping failed');
      return 'unavailable';
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool?.end();
  }
}
