/**
 * Turns the database's refusals into HTTP answers. The service checks every
 * rule first so the usual answer names the problem precisely; these cover
 * the races where another request got there between the check and the write
 * (a name taken, a resource gone) and the integrity triggers of 0001.
 */
import { BadRequestException, ConflictException, HttpException } from '@nestjs/common';
import { pgError, SQLSTATE } from '../common/pg-error.js';

export { pgError };

/** 409 for a configuration name another configuration already has. */
export const nameTaken = (name: string): ConflictException =>
  new ConflictException({
    statusCode: 409,
    message: `a configuration named ${name} already exists`,
  });

/**
 * Maps a failed configuration write to its HTTP answer, or returns the error
 * unchanged when it is not one the database raises for a bad request.
 */
export function translateWriteError(err: unknown, name: string): unknown {
  if (err instanceof HttpException) return err;
  const pg = pgError(err);
  if (!pg) return err;
  if (pg.code === SQLSTATE.uniqueViolation && pg.constraint === 'configurations_name_uq') {
    return nameTaken(name);
  }
  if (pg.code === SQLSTATE.foreignKeyViolation) {
    // The refs trigger, or the duplicated-from key: a resource or version went away mid-save.
    return new BadRequestException({
      statusCode: 400,
      message:
        'a skill, document, MCP server version or source version this configuration references does not exist',
    });
  }
  if (
    pg.code === SQLSTATE.restrictViolation &&
    pg.message.includes('two versions of the same MCP server')
  ) {
    return new BadRequestException({
      statusCode: 400,
      message: 'a configuration uses one version of each MCP server',
      issues: [{ path: 'mcpServerVersionIds', message: 'two versions of the same MCP server' }],
    });
  }
  return err;
}
