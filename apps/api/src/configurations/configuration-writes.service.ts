/**
 * Saving configurations (plan section 6, UI_FLOWS 10.1). A new configuration
 * and its version 1 are inserted in one transaction. An edit locks the
 * latest version: if an experiment has used it (frozen) the edit becomes the
 * next version and the experiments keep the old one; otherwise the version
 * is updated in place. Saving never calls a model, so it is never blocked by
 * provider status.
 *
 * The database backs every rule: the refs trigger checks the ids exist,
 * allows one version per MCP server and freezes the MCP definitions a
 * version uses; the guard trigger refuses any change to a frozen version.
 */
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, ne } from 'drizzle-orm';
import {
  SKILL_LOADING_NEEDS_SKILLS,
  type ConfigurationInput,
  type ConfigurationSaveResult,
} from '@hermes-evals/shared';
import { DB } from '../database/db.provider.js';
import { configurations, configurationVersions } from '../database/schema/index.js';
import type { AppDb, AppTx } from '../database/types.js';
import { nameTaken, translateWriteError } from './db-errors.js';
import { invalidFields, loadResources, pickResources, resolveForSave } from './references.js';
import {
  changeNote,
  configHash,
  orderSettings,
  sameSettings,
  type ResolvedSettings,
  type VersionOrigin,
} from './settings.js';
import { availableToolsets } from './toolsets.js';
import { loadVersionPairs, settingsOf, versionRef, type VersionRow } from './views.js';

/** The stored columns of a version's settings. Lists are already in canonical order. */
function settingsColumns(s: ResolvedSettings) {
  return {
    model: s.model,
    provider: s.provider,
    baseUrl: s.baseUrl,
    toolsets: s.toolsets,
    memoryEnabled: s.memoryEnabled,
    skillIds: s.skills.map((k) => k.skillId),
    skillLoading: s.skillLoading,
    documentIds: s.documents.map((d) => d.documentId),
    mcpServerVersionIds: s.mcpServers.map((m) => m.versionId),
    maxTurns: s.maxTurns,
    timeBudgetS: s.timeBudgetS,
    configHash: configHash(s),
  };
}

@Injectable()
export class ConfigurationWritesService {
  constructor(@Inject(DB) private readonly db: AppDb) {}

  /** POST /configurations: the configuration and its version 1. */
  async create(input: ConfigurationInput): Promise<ConfigurationSaveResult> {
    try {
      return await this.db.transaction(async (tx) => {
        await this.assertNameFree(tx, input.name, null);
        const settings = await this.settingsFrom(tx, input);
        const origin = await this.duplicateOrigin(tx, input.duplicatedFromVersionId);
        const [configuration] = await tx
          .insert(configurations)
          .values({ name: input.name, latestVersion: 1 })
          .returning({ id: configurations.id });
        // latest_version's foreign key is deferred to commit, so the version may follow.
        const [version] = await tx
          .insert(configurationVersions)
          .values({
            configurationId: configuration!.id,
            version: 1,
            ...settingsColumns(settings),
            changeNote: changeNote(origin, settings),
            duplicatedFromVersionId: input.duplicatedFromVersionId,
          })
          .returning({ id: configurationVersions.id });
        return {
          configurationId: configuration!.id,
          versionId: version!.id,
          version: 1,
          createdNewVersion: true,
        };
      });
    } catch (err) {
      throw translateWriteError(err, input.name);
    }
  }

  /**
   * PUT /configurations/:id. `duplicatedFromVersionId` is ignored: where a
   * configuration came from never changes. A save whose settings equal the
   * latest version's creates nothing (a rename alone only renames).
   */
  async update(id: string, input: ConfigurationInput): Promise<ConfigurationSaveResult> {
    try {
      return await this.db.transaction(async (tx) => {
        // The configuration row first: it serialises concurrent edits of one
        // configuration, so two saves of a frozen version make v2 then v3.
        const [configuration] = await tx
          .select()
          .from(configurations)
          .where(eq(configurations.id, id))
          .for('update');
        if (!configuration) {
          throw new NotFoundException({
            statusCode: 404,
            message: `configuration ${id} not found`,
          });
        }
        // Then the latest version: launch freezes a version with an UPDATE,
        // which waits for this lock, so the frozen check below cannot go stale.
        const [latest] = await tx
          .select()
          .from(configurationVersions)
          .where(
            and(
              eq(configurationVersions.configurationId, id),
              eq(configurationVersions.version, configuration.latestVersion),
            ),
          )
          .for('update');
        if (!latest)
          throw new Error(`configuration ${id} has no version ${configuration.latestVersion}`);

        if (input.name !== configuration.name) {
          await this.assertNameFree(tx, input.name, id);
          await tx
            .update(configurations)
            .set({ name: input.name })
            .where(eq(configurations.id, id));
        }

        const settings = await this.settingsFrom(tx, input);
        const current = await this.storedSettings(tx, latest);
        const unchanged = { configurationId: id, versionId: latest.id, version: latest.version };
        if (sameSettings(settings, current)) return { ...unchanged, createdNewVersion: false };

        if (latest.frozenAt !== null) {
          const next = latest.version + 1;
          const [created] = await tx
            .insert(configurationVersions)
            .values({
              configurationId: id,
              version: next,
              ...settingsColumns(settings),
              changeNote: changeNote({ kind: 'next', previous: current }, settings),
            })
            .returning({ id: configurationVersions.id });
          await tx
            .update(configurations)
            .set({ latestVersion: next })
            .where(eq(configurations.id, id));
          return {
            configurationId: id,
            versionId: created!.id,
            version: next,
            createdNewVersion: true,
          };
        }

        const origin = await this.originOf(tx, latest);
        await tx
          .update(configurationVersions)
          .set({
            ...settingsColumns(settings),
            changeNote: changeNote(origin, settings),
            updatedAt: new Date(),
          })
          .where(eq(configurationVersions.id, latest.id));
        return { ...unchanged, createdNewVersion: false };
      });
    } catch (err) {
      throw translateWriteError(err, input.name);
    }
  }

  /** 409 when another configuration has the name. `except` is the one being renamed. */
  private async assertNameFree(tx: AppTx, name: string, except: string | null): Promise<void> {
    const [clash] = await tx
      .select({ id: configurations.id })
      .from(configurations)
      .where(
        except === null
          ? eq(configurations.name, name)
          : and(eq(configurations.name, name), ne(configurations.id, except)),
      )
      .limit(1);
    if (clash) throw nameTaken(name);
  }

  /**
   * The settings a save stores: model trimmed, toolsets sorted, de-duplicated
   * and checked against the runtime's list, resources resolved and checked.
   */
  private async settingsFrom(tx: AppTx, input: ConfigurationInput): Promise<ResolvedSettings> {
    // ConfigurationInputSchema refuses this before a request gets here; a
    // caller inside the API is held to the same rule (and the 0008 CHECK).
    if (input.skillLoading === 'on_demand' && input.skillIds.length === 0) {
      throw invalidFields([{ path: 'skillLoading', message: SKILL_LOADING_NEEDS_SKILLS }]);
    }
    // Sequential, never Promise.all: a transaction is one connection.
    const resources = await resolveForSave(tx, input);
    const toolsets = await availableToolsets(tx);
    const known = new Set(toolsets.names);
    const unknown = input.toolsets.filter((t) => !known.has(t));
    if (unknown.length > 0) {
      const from = toolsets.source === 'worker' ? 'the worker reports' : 'Hermes offers';
      throw invalidFields([
        {
          path: 'toolsets',
          message: `unknown toolset${unknown.length === 1 ? '' : 's'} ${unknown.join(', ')}; ${from}: ${toolsets.names.join(', ')}`,
        },
      ]);
    }
    return orderSettings({
      model: input.model.trim(),
      provider: input.provider,
      baseUrl: input.baseUrl,
      toolsets: input.toolsets,
      memoryEnabled: input.memoryEnabled,
      ...resources,
      skillLoading: input.skillLoading,
      maxTurns: input.maxTurns,
      timeBudgetS: input.timeBudgetS,
    });
  }

  private async storedSettings(db: AppDb, row: VersionRow): Promise<ResolvedSettings> {
    const index = await loadResources(db, [row]);
    return settingsOf(row, pickResources(index, row));
  }

  /** The origin of a new configuration: created, or duplicated from an existing version. */
  private async duplicateOrigin(tx: AppTx, sourceId: string | null): Promise<VersionOrigin> {
    if (sourceId === null) return { kind: 'created' };
    const [source] = await loadVersionPairs(tx, [sourceId]);
    if (!source) {
      throw invalidFields([
        {
          path: 'duplicatedFromVersionId',
          message: `configuration version ${sourceId} does not exist`,
        },
      ]);
    }
    return {
      kind: 'duplicated',
      source: versionRef(source.configuration, source.row),
      settings: await this.storedSettings(tx, source.row),
    };
  }

  /**
   * What an in-place edit's history line compares against: version n - 1,
   * or for version 1 its duplication source (or nothing: "Created").
   */
  private async originOf(tx: AppTx, row: VersionRow): Promise<VersionOrigin> {
    if (row.version === 1) return this.duplicateOrigin(tx, row.duplicatedFromVersionId);
    const [previous] = await tx
      .select()
      .from(configurationVersions)
      .where(
        and(
          eq(configurationVersions.configurationId, row.configurationId),
          eq(configurationVersions.version, row.version - 1),
        ),
      );
    if (!previous) return { kind: 'created' };
    return { kind: 'next', previous: await this.storedSettings(tx, previous) };
  }
}
