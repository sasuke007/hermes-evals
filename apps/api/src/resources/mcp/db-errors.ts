/**
 * The database refusals an MCP save can meet, as HTTP answers. The service
 * checks each rule before writing; these cover the races where another
 * request got there between the check and the write.
 */
import { ConflictException } from '@nestjs/common';
import { pgError, SQLSTATE } from '../../common/pg-error.js';

/** 409 for a name another MCP server already has. */
export const mcpNameTaken = (name: string): ConflictException =>
  new ConflictException({ statusCode: 409, message: `an MCP server named ${name} already exists` });

/** A unique violation on the server name, from the insert or the rename. */
export const isNameTaken = (err: unknown): boolean => {
  const pg = pgError(err);
  return pg?.code === SQLSTATE.uniqueViolation && pg.constraint === 'mcp_servers_name_uq';
};

/** The frozen-definition guard refused an in-place edit: a configuration froze it meanwhile. */
export const isFrozenMeanwhile = (err: unknown): boolean =>
  pgError(err)?.code === SQLSTATE.restrictViolation;
