import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';
import type { Env } from '../config/env.js';
import { migrationsInSync, runMigrations, type MigrationReport } from './migrator.js';

export type MigrationState = 'ok' | 'unavailable' | 'not_configured';

/** Network-level failures that mean "Postgres is not reachable yet", not "the SQL is wrong". */
const CONNECTION_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EADDRNOTAVAIL',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'EPIPE',
  '57P03', // cannot_connect_now: the server is starting up
]);

/**
 * True when an error means Postgres could not be reached, as opposed to a
 * query that failed. pg reports a connection the server accepted and then
 * closed (common while Postgres starts) as a plain Error with no code.
 */
export function isConnectionError(err: unknown): boolean {
  if (err instanceof AggregateError) return err.errors.some(isConnectionError);
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string') return CONNECTION_ERROR_CODES.has(code);
  return err.message === 'Connection terminated unexpectedly';
}

/**
 * Applies pending migrations when the process boots, in both the API and the
 * worker. The advisory lock in runMigrations serialises the two, so the second
 * process finds nothing left to do. Nest finishes every onModuleInit before
 * the API listens, so the health endpoint only answers on a migrated schema.
 *
 * Postgres unreachable: the process keeps running in a degraded state, so
 * local development works without a database. Any other failure, such as a
 * migration whose SQL fails, stops the process.
 */
@Injectable()
export class MigrationService implements OnModuleInit {
  private state: MigrationState = 'not_configured';
  private lastReport: MigrationReport | null = null;

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(MigrationService.name);
  }

  async onModuleInit(): Promise<void> {
    const url = this.config.get('DATABASE_URL', { infer: true });
    if (!url) {
      this.logger.warn('migrations skipped: DATABASE_URL is not set');
      return;
    }
    let report: MigrationReport;
    try {
      report = await runMigrations(url);
    } catch (err) {
      if (isConnectionError(err)) {
        this.state = 'unavailable';
        this.logger.warn({ err }, 'migrations skipped: database unreachable');
        return;
      }
      throw err;
    }
    // drizzle's migrator applies only files newer than the last recorded one
    // and never re-checks hashes. Refuse to run on a schema that differs.
    if (!migrationsInSync(report)) {
      throw new Error(
        report.mismatch
          ? `migration ${report.mismatch} differs from the one recorded in the database; ` +
              'applied migrations must never be edited'
          : `database has ${report.applied} migrations recorded but this build ships ${report.available}`,
      );
    }
    this.lastReport = report;
    this.state = 'ok';
    this.logger.info(report, 'database migrations up to date');
  }

  status(): MigrationState {
    return this.state;
  }

  report(): MigrationReport | null {
    return this.lastReport;
  }
}
