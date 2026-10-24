/**
 * Saving MCP server definitions (plan 5.3, UI_FLOWS 9.3). A server is a name
 * plus numbered definitions. Editing a definition no configuration uses
 * rewrites it; editing a frozen one adds the next version, so configurations
 * on the old one keep exactly what they were saved with.
 *
 * The body schema already refuses reserved names (provider keys and the
 * platform's own variables). A save also refuses a name used both ways: a
 * stdio env name puts its value in the trial, where the agent reads it, so it
 * may not be a variable an http server's header takes from egress, whose
 * values never enter a run; and the reverse. That needs the stored
 * definitions, so it is checked here, with saves serialised by an advisory lock.
 */
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, ne, sql } from 'drizzle-orm';
import type { McpServerInput, McpServerRow } from '@hermes-evals/shared';
import { DB } from '../../database/db.provider.js';
import { newId } from '../../database/ids.js';
import { mcpServers, mcpServerVersions } from '../../database/schema/index.js';
import type { AppDb, AppTx } from '../../database/types.js';
import { isFrozenMeanwhile, isNameTaken, mcpNameTaken } from './db-errors.js';
import { definitionOf, planEdit, versionColumns } from './definition.js';
import { headerVariableUses, loadMcpServerRows, stdioEnvUses } from './mcp-reads.js';

export const mcpServerNotFound = (id: string): NotFoundException =>
  new NotFoundException({ statusCode: 404, message: `no MCP server ${id}` });

@Injectable()
export class McpServersService {
  constructor(@Inject(DB) private readonly db: AppDb) {}

  list(): Promise<McpServerRow[]> {
    return loadMcpServerRows(this.db);
  }

  /** POST /resources/mcp-servers: the server and its version 1 in one transaction. */
  async create(input: McpServerInput): Promise<McpServerRow> {
    try {
      const id = await this.db.transaction(async (tx) => {
        await lockVariableNames(tx);
        await this.assertNameFree(tx, input.name);
        await assertNoCrossUse(tx, input);
        const serverId = newId();
        // The latest-version foreign key is deferred, so the identity can come first.
        await tx.insert(mcpServers).values({ id: serverId, name: input.name, latestVersion: 1 });
        await tx
          .insert(mcpServerVersions)
          .values({ id: newId(), mcpServerId: serverId, version: 1, ...versionColumns(input) });
        return serverId;
      });
      return await this.row(id);
    } catch (err) {
      if (isNameTaken(err)) throw mcpNameTaken(input.name);
      throw err;
    }
  }

  /**
   * PUT /resources/mcp-servers/:id. The server row and its latest version are
   * locked, so two saves of one server apply one after the other and a
   * configuration save cannot freeze the version between the check and the write.
   */
  async update(id: string, input: McpServerInput): Promise<McpServerRow> {
    try {
      await this.db.transaction(async (tx) => {
        await lockVariableNames(tx);
        const [server] = await tx
          .select()
          .from(mcpServers)
          .where(eq(mcpServers.id, id))
          .for('update');
        if (!server) throw mcpServerNotFound(id);
        const [latest] = await tx
          .select()
          .from(mcpServerVersions)
          .where(
            and(
              eq(mcpServerVersions.mcpServerId, id),
              eq(mcpServerVersions.version, server.latestVersion),
            ),
          )
          .for('update');
        if (!latest) throw new Error(`MCP server ${id} has no version ${server.latestVersion}`);

        const plan = planEdit(
          {
            definition: definitionOf(server.name, latest),
            version: latest.version,
            definitionHash: latest.definitionHash,
            frozen: latest.frozenAt !== null,
          },
          input,
        );
        switch (plan.kind) {
          case 'refuse_rename':
            throw new BadRequestException({
              statusCode: 400,
              message:
                `${server.name} is the name configurations use for this server, so it cannot ` +
                'change; define a new server with the new name instead',
              issues: [
                { path: 'name', message: 'a server a configuration has used keeps its name' },
              ],
            });
          case 'unchanged':
            return;
          case 'in_place':
            // The version being rewritten no longer counts as a use.
            await assertNoCrossUse(tx, input, latest.id);
            if (input.name !== server.name) {
              await this.assertNameFree(tx, input.name, id);
              await tx.update(mcpServers).set({ name: input.name }).where(eq(mcpServers.id, id));
            }
            await tx
              .update(mcpServerVersions)
              .set({
                ...versionColumns(input),
                ...(plan.resetTest ? { lastTest: { status: 'untested' as const } } : {}),
                updatedAt: sql`now()`,
              })
              .where(eq(mcpServerVersions.id, latest.id));
            return;
          case 'new_version':
            await assertNoCrossUse(tx, input);
            await tx.insert(mcpServerVersions).values({
              id: newId(),
              mcpServerId: id,
              version: plan.version,
              ...versionColumns(input),
            });
            await tx
              .update(mcpServers)
              .set({ latestVersion: plan.version })
              .where(eq(mcpServers.id, id));
            return;
        }
      });
    } catch (err) {
      if (isNameTaken(err)) throw mcpNameTaken(input.name);
      if (isFrozenMeanwhile(err)) {
        throw new ConflictException({
          statusCode: 409,
          message:
            'a configuration started using this definition while it was saved; save again to create a new version',
        });
      }
      throw err;
    }
    return this.row(id);
  }

  private async row(id: string): Promise<McpServerRow> {
    const [row] = await loadMcpServerRows(this.db, [id]);
    if (!row) throw mcpServerNotFound(id);
    return row;
  }

  /** 409 when another server has the name; the unique index catches a concurrent save. */
  private async assertNameFree(tx: AppTx, name: string, exceptId?: string): Promise<void> {
    const [taken] = await tx
      .select({ id: mcpServers.id })
      .from(mcpServers)
      .where(
        exceptId
          ? and(eq(mcpServers.name, name), ne(mcpServers.id, exceptId))
          : eq(mcpServers.name, name),
      )
      .limit(1);
    if (taken) throw mcpNameTaken(name);
  }
}

/** Serialises saves, so two at once cannot both pass the cross-use check. Taken before any row lock. */
async function lockVariableNames(tx: AppTx): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended('hermes-evals:mcp-variables', 0))`,
  );
}

/**
 * 400 when the definition would use a variable name both as a stdio env name
 * and as an http header variable, with any stored version but `exceptVersionId`.
 */
async function assertNoCrossUse(
  tx: AppTx,
  input: McpServerInput,
  exceptVersionId?: string,
): Promise<void> {
  const refuse = (path: 'envNames' | 'headers', message: string) =>
    new BadRequestException({ statusCode: 400, message, issues: [{ path, message }] });
  if (input.transport === 'stdio') {
    const [use] = await headerVariableUses(tx, input.envNames, exceptVersionId);
    if (use) {
      throw refuse(
        'envNames',
        `${use.env} is the header variable of http server ${use.server}; egress holds its value ` +
          'and it never enters a trial',
      );
    }
  } else {
    const names = input.headers.map((h) => h.env);
    const [use] = await stdioEnvUses(tx, names, exceptVersionId);
    if (use) {
      throw refuse(
        'headers',
        `${use.env} is an env name of stdio server ${use.server}, which sets its value in the ` +
          'trial; a header variable must be one no stdio server uses',
      );
    }
  }
}
