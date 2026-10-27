/**
 * The samples seed (Phase 8 G3) on PGlite with the real migrations, over the
 * repository's samples/: what a fresh database gets, that a second run
 * skips everything (and adds no row), that a changed sample skill becomes
 * its next version while the rest is skipped, that what the user already
 * has is left alone, and that a missing folder or a broken file stops the
 * seed before it adds anything. Every view is checked with its shared schema.
 * The documents' rule (same name and content) is in
 * seed-documents.integration.spec.ts.
 */
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { count, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ConfigurationDetailSchema,
  ConfigurationInputSchema,
  DocumentRowSchema,
  McpServerRowSchema,
  SAMPLE_EXPERIMENT,
  SeedItemSchema,
  SkillRowSchema,
  seedCounts,
  type SeedItem,
} from '@hermes-evals/shared';
import { createTestDatabase, type TestDatabase } from '../../test/support/database.js';
import { ConfigurationReadsService } from '../configurations/configuration-reads.service.js';
import {
  configurations,
  configurationVersions,
  documents,
  mcpServers,
  skills,
} from '../database/schema/index.js';
import type { McpServersService } from '../resources/mcp/mcp-servers.service.js';
import { SAMPLES, seedDepsOn } from './seed.helper-spec.js';
import { seedSamples, type SeedDeps } from './seed.js';

// PGlite databases are slow to create when every test file runs at once.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

let t: TestDatabase;
let dataDir: string;
let items: SeedItem[];
let deps: SeedDeps;
let mcp: McpServersService;

beforeEach(async () => {
  t = await createTestDatabase();
  dataDir = await mkdtemp(join(tmpdir(), 'samples-seed-'));
  items = [];
  deps = seedDepsOn(t, dataDir, (item) => items.push(SeedItemSchema.parse(item)));
  mcp = deps.mcpServers;
});

afterEach(async () => {
  await t.close();
  await rm(dataDir, { recursive: true, force: true });
});

/** Seeds `dir` and returns what it reported this time. */
async function seed(dir = SAMPLES): Promise<SeedItem[]> {
  items = [];
  await seedSamples(deps, dir);
  return items;
}

const rows = async () => ({
  skills: (await t.db.select({ n: count() }).from(skills))[0]!.n,
  documents: (await t.db.select({ n: count() }).from(documents))[0]!.n,
  mcpServers: (await t.db.select({ n: count() }).from(mcpServers))[0]!.n,
  configurations: (await t.db.select({ n: count() }).from(configurations))[0]!.n,
  versions: (await t.db.select({ n: count() }).from(configurationVersions))[0]!.n,
});

const byKind = (seeded: SeedItem[]) => ({
  skill: seeded.filter((i) => i.kind === 'skill').length,
  document: seeded.filter((i) => i.kind === 'document').length,
  mcp_server: seeded.filter((i) => i.kind === 'mcp_server').length,
  configuration: seeded.filter((i) => i.kind === 'configuration').length,
});

/** A writable copy of samples/, to change. */
async function copyOfSamples(): Promise<string> {
  const dir = join(await mkdtemp(join(tmpdir(), 'samples-copy-')), 'samples');
  await cp(SAMPLES, dir, { recursive: true });
  return dir;
}

describe('a fresh database', () => {
  it('gets every sample through the services, in kind order, and the second run skips them all', async () => {
    const first = await seed();
    expect(first.filter((i) => i.outcome !== 'created')).toEqual([]);
    expect(byKind(first)).toEqual({ skill: 4, document: 8, mcp_server: 2, configuration: 26 });
    // Skills, then documents, then servers, then the configurations that name them.
    const order = first.map((i) => i.kind);
    expect(order).toEqual([...order].sort((a, b) => kindRank(a) - kindRank(b)));
    expect(first.slice(0, 4).map((i) => [i.name, i.detail])).toEqual([
      ['bx6-format', expect.stringMatching(/^version \S+$/)],
      ['bx7-format', expect.stringMatching(/^version \S+$/)],
      ['house-style', expect.stringMatching(/^version \S+$/)],
      ['invoice-method', expect.stringMatching(/^version \S+$/)],
    ]);
    expect(first.filter((i) => i.kind === 'document').map((i) => i.name)).toEqual([
      'knowledge-v1/bx6-spec.md',
      'knowledge-v1/bx7-spec.md',
      'knowledge-v1/bx7.py',
      'knowledge-v1/codes.md',
      'knowledge-v1/house-style.md',
      'knowledge-v1/summary-template.md',
      'mcp-v1/invoices.csv',
      'mcp-v1/vendors.json',
    ]);
    const after = await rows();
    expect(after).toEqual({
      skills: 4,
      documents: 8,
      mcpServers: 2,
      configurations: 26,
      versions: 26,
    });

    const second = await seed();
    expect(seedCounts({ items: second })).toEqual({ created: 0, skipped: 40, failed: 0 });
    expect(second.find((i) => i.name === 'invoice-method')!.detail).toMatch(
      /^exists with the same content \(version \S+\)$/,
    );
    expect(second.find((i) => i.name === 'mcp-v1/invoices.csv')!.detail).toBe(
      'exists with the same name and content',
    );
    expect(await rows()).toEqual(after);
  });

  it('stores what the pages show: skills, documents, the two servers, and configurations that name them', async () => {
    await seed();
    const skillRows = SkillRowSchema.array().parse(await deps.skills.list());
    expect(skillRows.map((s) => s.name)).toEqual([
      'bx6-format',
      'bx7-format',
      'house-style',
      'invoice-method',
    ]);
    const docRows = DocumentRowSchema.array().parse(await deps.documents.list());
    expect(docRows.map((d) => d.filename).sort()).toContain('vendors.json');
    const servers = McpServerRowSchema.array().parse(await mcp.list());
    expect(servers.map((s) => [s.name, s.transport, s.envNames, s.headers, s.url])).toEqual([
      ['invoice-db', 'stdio', ['INVOICE_DB_URL'], [], null],
      [
        'vendor-directory',
        'http',
        [],
        [{ header: 'Authorization', env: 'VENDOR_DIRECTORY_TOKEN', prefix: 'Bearer ' }],
        'http://vendor-directory:8000/mcp',
      ],
    ]);

    const reads = new ConfigurationReadsService(t.db);
    const detail = async (name: string) => {
      const [row] = await t.db
        .select({ id: configurations.id })
        .from(configurations)
        .where(eq(configurations.name, name));
      return ConfigurationDetailSchema.parse(await reads.detail(row!.id));
    };
    const candidate = await detail(SAMPLE_EXPERIMENT.candidate);
    expect(candidate.latest).toMatchObject({
      provider: 'custom',
      baseUrl: 'http://mock-model:8090/v1',
      model: 'mock/scripted',
      toolsets: ['file', 'terminal'],
      memoryEnabled: false,
      skillLoading: 'preload',
      maxTurns: 10,
      timeBudgetS: 180,
    });
    expect(candidate.latest.skills.map((s) => s.name)).toEqual(['invoice-method']);
    const withMcp = await detail('mcp-v1-with-mcp');
    expect(withMcp.latest).toMatchObject({
      provider: 'nous',
      baseUrl: null,
      model: 'openai/gpt-6.1-sol',
      maxTurns: 30,
      timeBudgetS: 600,
    });
    expect(withMcp.latest.mcpServers.map((m) => m.name).sort()).toEqual([
      'invoice-db',
      'vendor-directory',
    ]);
    const docs = await detail('knowledge-v1-docs-mock');
    expect(docs.latest.documents.map((d) => d.filename).sort()).toEqual([
      'bx6-spec.md',
      'bx7-spec.md',
      'bx7.py',
      'codes.md',
      'house-style.md',
      'summary-template.md',
    ]);
  });
});

describe('a database with things in it', () => {
  it('leaves what the user has: a configuration or server of that name, whatever it holds', async () => {
    await deps.configurations.create({
      ...baselineInput(),
      name: SAMPLE_EXPERIMENT.baseline,
      maxTurns: 7,
    });
    await mcp.create({
      name: 'vendor-directory',
      transport: 'http',
      command: null,
      args: [],
      envNames: [],
      url: 'http://elsewhere:9000/mcp',
      headers: [],
      include: [],
      exclude: [],
      timeoutS: 30,
    });
    const seeded = await seed();
    expect(seeded.find((i) => i.name === SAMPLE_EXPERIMENT.baseline)).toEqual({
      kind: 'configuration',
      name: SAMPLE_EXPERIMENT.baseline,
      outcome: 'skipped',
      detail: 'a configuration with this name exists',
    });
    expect(seeded.find((i) => i.name === 'vendor-directory')).toMatchObject({
      outcome: 'skipped',
      detail: 'exists (version 1); its definition is left as it is',
    });
    const [kept] = await t.db
      .select({ maxTurns: configurationVersions.maxTurns })
      .from(configurationVersions)
      .innerJoin(configurations, eq(configurations.id, configurationVersions.configurationId))
      .where(eq(configurations.name, SAMPLE_EXPERIMENT.baseline));
    expect(kept!.maxTurns).toBe(7);
    // The configurations that need vendor-directory use the one that exists.
    expect(seeded.filter((i) => i.outcome === 'failed')).toEqual([]);
  });

  it('stores a changed sample skill as its next version and skips the rest', async () => {
    const dir = await copyOfSamples();
    try {
      await seed(dir);
      const skillMd = join(dir, 'skills', 'house-style', 'SKILL.md');
      const text = await readFile(skillMd, 'utf8');
      const bumped = text.replace(/^version: .*$/m, 'version: 9.9.9');
      expect(bumped).not.toBe(text);
      await writeFile(skillMd, `${bumped}\nOne more line.\n`);
      const seeded = await seed(dir);
      expect(seeded.filter((i) => i.outcome === 'created')).toEqual([
        {
          kind: 'skill',
          name: 'house-style',
          outcome: 'created',
          detail: expect.stringMatching(/^version 9\.9\.9, beside \S+$/),
        },
      ]);
      expect(seedCounts({ items: seeded })).toEqual({ created: 1, skipped: 39, failed: 0 });
    } finally {
      await rm(join(dir, '..'), { recursive: true, force: true });
    }
  });

  it('reports a skill the upload check refuses, and the configurations that need it, and goes on', async () => {
    const dir = await copyOfSamples();
    try {
      // Same name and version as the stored one, other content: the upload says bump the version.
      await seed(dir);
      await writeFile(join(dir, 'skills', 'bx6-format', 'extra.md'), 'not in the stored copy\n');
      // Renamed by the user, so the seed would make it again.
      await t.db
        .update(configurations)
        .set({ name: 'my-knowledge-preload' })
        .where(eq(configurations.name, 'knowledge-v1-skills-preload'));
      const seeded = await seed(dir);
      expect(seeded.find((i) => i.name === 'bx6-format')).toEqual({
        kind: 'skill',
        name: 'bx6-format',
        outcome: 'failed',
        detail: expect.stringMatching(/already exists with a different hash\. Bump version/),
      });
      expect(seeded.find((i) => i.name === 'knowledge-v1-skills-preload')).toEqual({
        kind: 'configuration',
        name: 'knowledge-v1-skills-preload',
        outcome: 'failed',
        detail: 'needs skill bx6-format, which the seed could not find or store',
      });
      expect(seedCounts({ items: seeded })).toEqual({ created: 0, skipped: 38, failed: 2 });
    } finally {
      await rm(join(dir, '..'), { recursive: true, force: true });
    }
  });
});

describe('a seed that cannot go on', () => {
  it('stops at a missing folder or a broken configurations.yaml, before adding anything', async () => {
    await expect(seed(join(dataDir, 'nowhere'))).rejects.toThrow(
      /^no samples folder at .*nowhere \(SAMPLES_DIR\)$/,
    );
    const dir = await copyOfSamples();
    try {
      await writeFile(join(dir, 'configurations.yaml'), 'families: {}\nsuites: {}\n');
      await expect(seed(dir)).rejects.toThrow(/^configurations\.yaml at families\.real: /);
      expect(await rows()).toEqual({
        skills: 0,
        documents: 0,
        mcpServers: 0,
        configurations: 0,
        versions: 0,
      });
    } finally {
      await rm(join(dir, '..'), { recursive: true, force: true });
    }
  });
});

function kindRank(kind: SeedItem['kind']): number {
  return ['skill', 'document', 'mcp_server', 'configuration'].indexOf(kind);
}

function baselineInput() {
  return ConfigurationInputSchema.parse({
    name: 'placeholder',
    model: 'mock/scripted',
    provider: 'custom',
    baseUrl: 'http://mock-model:8090/v1',
    toolsets: ['file', 'terminal'],
    memoryEnabled: false,
    skillIds: [],
    skillLoading: 'preload',
    documentIds: [],
    mcpServerVersionIds: [],
    maxTurns: 10,
    timeBudgetS: 180,
    duplicatedFromVersionId: null,
  });
}
