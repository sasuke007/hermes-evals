/**
 * Reading configurations: the list, a detail at any version, the diff the
 * New experiment form, the list's Compare and the detail's "Compare with…"
 * all share, and the form's starting drafts (edit, duplicate). Nothing here
 * writes; a duplicate draft stores nothing until it is saved.
 */
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { desc, eq, or, sql } from 'drizzle-orm';
import type {
  ConfigDiff,
  ConfigurationDetail,
  ConfigurationDraft,
  ConfigurationListRow,
} from '@hermes-evals/shared';
import { DB } from '../database/db.provider.js';
import { configurations, configurationVersions, experiments } from '../database/schema/index.js';
import type { AppDb } from '../database/types.js';
import { configDiff, copyName, differingFields } from './settings.js';
import { configurationUsage, experimentsUsing } from './usage.js';
import {
  buildVersions,
  loadLatestPairs,
  loadVersionPairs,
  versionRef,
  type ConfigurationRow,
  type VersionRecord,
} from './views.js';

const notFound = (what: string) =>
  new NotFoundException({ statusCode: 404, message: `${what} not found` });

/** The form values a stored version starts from. */
function valuesOf(record: VersionRecord, duplicatedFromVersionId: string | null) {
  const v = record.view;
  return {
    name: v.name,
    model: v.model,
    provider: v.provider,
    baseUrl: v.baseUrl,
    toolsets: [...v.toolsets],
    memoryEnabled: v.memoryEnabled,
    skillIds: v.skills.map((s) => s.skillId),
    documentIds: v.documents.map((d) => d.documentId),
    mcpServerVersionIds: v.mcpServers.map((m) => m.versionId),
    maxTurns: v.maxTurns,
    timeBudgetS: v.timeBudgetS,
    duplicatedFromVersionId,
  };
}

@Injectable()
export class ConfigurationReadsService {
  constructor(@Inject(DB) private readonly db: AppDb) {}

  /** GET /configurations: every configuration at its latest version, in creation order. */
  async list(): Promise<ConfigurationListRow[]> {
    const latest = await buildVersions(this.db, await loadLatestPairs(this.db));
    const used = await this.experimentsPerConfiguration();
    return latest.map((r) => ({
      id: r.configuration.id,
      name: r.configuration.name,
      createdAt: r.configuration.createdAt.toISOString(),
      latest: r.view,
      usedInExperiments: used.get(r.configuration.id) ?? 0,
    }));
  }

  /**
   * GET /configurations/:id, or /configurations/:id/versions/:v when
   * `version` is given. `versions` lists every version, newest first.
   */
  async detail(id: string, version?: number): Promise<ConfigurationDetail> {
    const { configuration, versions } = await this.loadConfiguration(id);
    const latest = versions.find((v) => v.view.latest);
    if (!latest) throw new Error(`configuration ${id} has no latest version`);
    const shown = version === undefined ? latest : versions.find((v) => v.row.version === version);
    if (!shown) throw notFound(`configuration ${configuration.name} v${version}`);

    // Only version 1 records an origin: later versions follow their own predecessor.
    const first = versions.find((v) => v.row.version === 1);
    const sourceId = first?.row.duplicatedFromVersionId ?? null;
    const [source] =
      sourceId === null
        ? []
        : await buildVersions(this.db, await loadVersionPairs(this.db, [sourceId]));

    return {
      id: configuration.id,
      name: configuration.name,
      createdAt: configuration.createdAt.toISOString(),
      shown: shown.view,
      latest: latest.view,
      versions: versions.map((v) => v.view),
      duplicatedFrom: source ? versionRef(source.configuration, source.row) : null,
      differsFromSource: source ? differingFields(source.settings, shown.settings) : [],
      usedIn: await configurationUsage(
        this.db,
        new Map(versions.map((v) => [v.row.id, v.row.version])),
      ),
    };
  }

  /** GET /configurations/diff?versions=a,b,c: columns in the order asked, the first is the reference. */
  async diff(versionIds: readonly string[]): Promise<ConfigDiff> {
    const pairs = await loadVersionPairs(this.db, versionIds);
    const byId = new Map(pairs.map((p) => [p.row.id, p]));
    const missing = versionIds.filter((v) => !byId.has(v));
    if (missing.length > 0) throw notFound(`configuration version ${missing.join(', ')}`);
    const records = await buildVersions(
      this.db,
      versionIds.map((v) => byId.get(v)!),
    );
    return configDiff(
      records.map((r) => ({ ref: versionRef(r.configuration, r.row), settings: r.settings })),
    );
  }

  /**
   * GET /configurations/:id/draft: the edit form for the latest version. On
   * a frozen version it says saving creates the next version and which
   * experiments keep this one ("Save as version 2").
   */
  async editDraft(id: string): Promise<ConfigurationDraft> {
    const { versions } = await this.loadConfiguration(id);
    const latest = versions.find((v) => v.view.latest)!;
    const first = versions.find((v) => v.row.version === 1);
    const frozen = latest.row.frozenAt !== null;
    const keeping = frozen ? await experimentsUsing(this.db, [latest.row.id]) : [];
    return {
      mode: 'edit',
      source: versionRef(latest.configuration, latest.row),
      values: valuesOf(latest, first?.row.duplicatedFromVersionId ?? null),
      createsNewVersion: frozen,
      nextVersion: frozen ? latest.row.version + 1 : null,
      experimentsKeepingVersion: keeping
        .toSorted((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .map((e) => ({ id: e.id, name: e.name })),
    };
  }

  /**
   * POST /configurations/:id/duplicate: the latest version's values under a
   * free "<name>-copy" name, pointing back at the version it copies. Nothing
   * is stored until the form saves it with POST /configurations.
   */
  async duplicateDraft(id: string): Promise<ConfigurationDraft> {
    const { configuration, versions } = await this.loadConfiguration(id);
    const latest = versions.find((v) => v.view.latest)!;
    // A local, single-user list: reading every name is cheaper than being clever.
    const taken = await this.db.select({ name: configurations.name }).from(configurations);
    return {
      mode: 'duplicate',
      source: versionRef(configuration, latest.row),
      values: {
        ...valuesOf(latest, latest.row.id),
        name: copyName(configuration.name, new Set(taken.map((t) => t.name))),
      },
      createsNewVersion: false,
      nextVersion: null,
      experimentsKeepingVersion: [],
    };
  }

  /** A configuration with every version resolved, newest first; 404 when it does not exist. */
  private async loadConfiguration(
    id: string,
  ): Promise<{ configuration: ConfigurationRow; versions: VersionRecord[] }> {
    const [configuration] = await this.db
      .select()
      .from(configurations)
      .where(eq(configurations.id, id));
    if (!configuration) throw notFound(`configuration ${id}`);
    const rows = await this.db
      .select()
      .from(configurationVersions)
      .where(eq(configurationVersions.configurationId, id))
      .orderBy(desc(configurationVersions.version));
    const versions = await buildVersions(
      this.db,
      rows.map((row) => ({ configuration, row })),
    );
    return { configuration, versions };
  }

  /** Distinct experiments that used any version of each configuration. */
  private async experimentsPerConfiguration(): Promise<Map<string, number>> {
    const rows = await this.db
      .select({
        configurationId: configurationVersions.configurationId,
        n: sql<number>`count(distinct ${experiments.id})`.mapWith(Number),
      })
      .from(configurationVersions)
      .innerJoin(
        experiments,
        or(
          eq(experiments.baselineVersionId, configurationVersions.id),
          sql`${configurationVersions.id} = any(${experiments.candidateVersionIds})`,
        ),
      )
      .groupBy(configurationVersions.configurationId);
    return new Map(rows.map((r) => [r.configurationId, r.n]));
  }
}
