/**
 * GET /configurations/form-options: everything the configuration form
 * offers. Models come from the price table merged with the models existing
 * configurations already use (unknown price: the form warns "cost will show
 * as —"); toolsets from the runtime; skills, documents and MCP servers from
 * the resource library. Each MCP server is offered at its latest definition,
 * plus every older one a configuration still pins, so a draft of that
 * configuration (edit or duplicate) finds its pin among the options.
 *
 * GET /configurations/new-draft: the form's starting values for a new
 * configuration, from the same options.
 */
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { asc, desc } from 'drizzle-orm';
import { PinoLogger } from 'nestjs-pino';
import {
  DEFAULT_TOOLSETS,
  NEW_CONFIGURATION_DEFAULTS,
  PROVIDERS,
  type ConfigurationDraft,
  type ConfigurationFormOptions,
  type Provider,
} from '@hermes-evals/shared';
import type { Env } from '../config/env.js';
import { DB } from '../database/db.provider.js';
import { configurationVersions, documents, skills } from '../database/schema/index.js';
import type { AppDb } from '../database/types.js';
import { latestVersions, referencedVersions } from '../resources/mcp/mcp-reads.js';
import { readPriceModels } from './prices.js';
import { availableToolsets } from './toolsets.js';

/** How the provider select names each provider (the ConfigForm artboard's wording). */
export const PROVIDER_LABELS: Record<Provider, string> = {
  nous: 'nous · Nous Portal',
  'nous-api': 'nous-api · Nous API key',
  openrouter: 'openrouter · OpenRouter',
  openai: 'openai · OpenAI',
  anthropic: 'anthropic · Anthropic',
  custom: 'custom · OpenAI-compatible URL',
};

/** "512 B", "214 KB", "1.4 MB": the size the document picker shows beside each file. */
export function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** What the MCP picker shows for a server: its command line (stdio) or URL (http). */
export function mcpEndpoint(v: {
  command: string | null;
  args: string[];
  url: string | null;
}): string {
  if (v.url !== null) return v.url;
  const quote = (a: string) => (/\s|^$/.test(a) ? JSON.stringify(a) : a);
  return [v.command ?? '', ...v.args].map(quote).join(' ');
}

@Injectable()
export class ConfigurationFormOptionsService {
  constructor(
    @Inject(DB) private readonly db: AppDb,
    private readonly config: ConfigService<Env, true>,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(ConfigurationFormOptionsService.name);
  }

  async formOptions(): Promise<ConfigurationFormOptions> {
    return {
      models: await this.models(),
      providers: PROVIDERS.map((id) => ({ id, label: PROVIDER_LABELS[id] })),
      toolsets: (await availableToolsets(this.db)).names.map((name) => ({
        name,
        defaultOn: (DEFAULT_TOOLSETS as readonly string[]).includes(name),
      })),
      skills: await this.db
        .select({
          skillId: skills.id,
          name: skills.name,
          version: skills.version,
          contentHash: skills.contentHash,
          description: skills.description,
        })
        .from(skills)
        .orderBy(asc(skills.name), desc(skills.uploadedAt), asc(skills.id)),
      documents: (
        await this.db
          .select({
            documentId: documents.id,
            filename: documents.filename,
            sizeBytes: documents.size,
            sha256: documents.sha256,
          })
          .from(documents)
          .orderBy(asc(documents.filename), desc(documents.uploadedAt), asc(documents.id))
      ).map((d) => ({ ...d, typeLabel: sizeLabel(d.sizeBytes) })),
      mcpServers: await this.mcpServers(),
    };
  }

  /**
   * A new configuration's draft: no name, the first model the form offers
   * (the price table's first), the toolsets on by default that this runtime
   * has, NEW_CONFIGURATION_DEFAULTS, and no skills, documents or MCP servers.
   * Nothing is stored.
   */
  async newDraft(): Promise<ConfigurationDraft> {
    const options = await this.formOptions();
    return {
      mode: 'new',
      source: null,
      values: {
        name: '',
        model: options.models[0]?.id ?? '',
        provider: NEW_CONFIGURATION_DEFAULTS.provider,
        baseUrl: null,
        toolsets: options.toolsets.filter((t) => t.defaultOn).map((t) => t.name),
        memoryEnabled: NEW_CONFIGURATION_DEFAULTS.memoryEnabled,
        skillIds: [],
        documentIds: [],
        mcpServerVersionIds: [],
        maxTurns: NEW_CONFIGURATION_DEFAULTS.maxTurns,
        timeBudgetS: NEW_CONFIGURATION_DEFAULTS.timeBudgetS,
        duplicatedFromVersionId: null,
      },
      createsNewVersion: false,
      nextVersion: null,
      experimentsKeepingVersion: [],
    };
  }

  /** Latest versions, then pinned older ones; by name, newest version first. */
  private async mcpServers(): Promise<ConfigurationFormOptions['mcpServers']> {
    const [latest, pinned] = await Promise.all([
      latestVersions(this.db),
      referencedVersions(this.db),
    ]);
    const byVersionId = new Map<string, (typeof latest)[number]>();
    for (const row of [...latest, ...pinned]) byVersionId.set(row.version.id, row);
    return [...byVersionId.values()]
      .sort((a, b) =>
        a.server.name === b.server.name
          ? b.version.version - a.version.version
          : a.server.name < b.server.name
            ? -1
            : 1,
      )
      .map(({ server, version }) => ({
        mcpServerId: server.id,
        versionId: version.id,
        name: server.name,
        version: version.version,
        transport: version.transport,
        endpoint: mcpEndpoint(version),
        latest: version.version === server.latestVersion,
      }));
  }

  /** Priced models in price-table order, then other models configurations use, alphabetically. */
  private async models(): Promise<ConfigurationFormOptions['models']> {
    const prices = await readPriceModels(this.config.get('PRICES_FILE', { infer: true }));
    if (prices.problem !== null) {
      this.logger.warn({ problem: prices.problem }, 'price table not usable; no model has a price');
    }
    const used = await this.db
      .selectDistinct({ model: configurationVersions.model })
      .from(configurationVersions)
      .orderBy(asc(configurationVersions.model));
    const priced = [...prices.models].map(([id, p]) => ({
      id,
      price: { inputPer1M: p.input_per_1m, outputPer1M: p.output_per_1m, checkedAt: p.checked_at },
    }));
    const unpriced = used
      .filter((u) => !prices.models.has(u.model))
      .map((u) => ({ id: u.model, price: null }));
    return [...priced, ...unpriced];
  }
}
