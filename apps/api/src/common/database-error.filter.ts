/**
 * The last line between an integrity violation and a bare 500. Services check
 * their rules before writing and answer precisely; what reaches this filter
 * is a refusal they did not foresee, usually a race (two saves of one name)
 * or an integrity trigger of 0001 (a frozen row). The database was right to
 * refuse, so the client hears why, in the API's error body
 * `{ statusCode, message }`, instead of "Internal server error":
 *
 * - unique_violation 23505 → 409
 * - restrict_violation 23001 (the triggers) → 409
 * - foreign_key_violation 23503 → 400
 * - check_violation 23514 → 400
 *
 * Anything else goes to Nest's own handling unchanged.
 */
import {
  BadRequestException,
  Catch,
  ConflictException,
  HttpException,
  type ArgumentsHost,
} from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { pgError, SQLSTATE, type PgErrorFields } from './pg-error.js';

/** What a unique constraint protects, for the 409 message. */
const UNIQUE_MEANING: Readonly<Record<string, string>> = {
  configurations_name_uq: 'a configuration with this name already exists',
  configuration_versions_config_version_uq: 'this configuration version number is already taken',
  mcp_servers_name_uq: 'an MCP server with this name already exists',
  mcp_server_versions_server_version_uq: 'this MCP server version number is already taken',
  skills_name_version_uq: 'this skill name and version are already stored',
  suite_sources_name_uq: 'another suite directory already declares this name',
  suites_source_version_uq: 'this suite version number is already taken',
};

/**
 * The HTTP answer for an integrity violation, or null for any other error.
 * Messages name the constraint, never the values: Postgres's DETAIL echoes
 * the row, which is not ours to repeat.
 */
export function databaseErrorAnswer(err: unknown): HttpException | null {
  // An answer a service already chose stands, even when it carries the database error as its cause.
  if (err instanceof HttpException) return null;
  const pg = pgError(err);
  if (!pg) return null;
  switch (pg.code) {
    case SQLSTATE.uniqueViolation:
      return new ConflictException({
        statusCode: 409,
        message:
          (pg.constraint ? UNIQUE_MEANING[pg.constraint] : undefined) ??
          `this would duplicate an existing record${constraintNote(pg)}`,
      });
    case SQLSTATE.restrictViolation:
      // The 0001 triggers raise this with a sentence written for the reader.
      return new ConflictException({
        statusCode: 409,
        message: pg.message || 'the database refused to change a record that is frozen',
      });
    case SQLSTATE.foreignKeyViolation:
      return new BadRequestException({ statusCode: 400, message: foreignKeyMessage(pg) });
    case SQLSTATE.checkViolation:
      return new BadRequestException({
        statusCode: 400,
        message: pg.constraint
          ? `a value is outside what the database allows${constraintNote(pg)}`
          : pg.message || 'a value is outside what the database allows',
      });
    default:
      return null;
  }
}

function constraintNote(pg: PgErrorFields): string {
  return pg.constraint ? ` (${pg.constraint})` : '';
}

/**
 * A foreign key refuses two different things: a write that points at a row
 * that does not exist, and a delete of a row something still points at. The
 * refs trigger raises the same code with its own sentence and no constraint.
 */
function foreignKeyMessage(pg: PgErrorFields): string {
  if (!pg.constraint) return pg.message || 'a referenced record does not exist';
  if (/still referenced/i.test(pg.message)) {
    return `the record is still in use${constraintNote(pg)}`;
  }
  return `a referenced record does not exist${constraintNote(pg)}`;
}

@Catch()
export class DatabaseErrorFilter extends BaseExceptionFilter {
  override catch(exception: unknown, host: ArgumentsHost): void {
    super.catch(databaseErrorAnswer(exception) ?? exception, host);
  }
}
