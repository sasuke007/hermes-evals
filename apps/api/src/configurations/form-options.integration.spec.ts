/** What the configuration form offers, from the price file, workers and the resource library. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConfigService } from '@nestjs/config';
import type { PinoLogger } from 'nestjs-pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ConfigurationDraftSchema,
  ConfigurationFormOptionsSchema,
  ConfigurationInputSchema,
  HERMES_TOOLSETS,
  SKILL_LOADING_OPTIONS,
} from '@hermes-evals/shared';
import { createTestDatabase, type TestDatabase } from '../../test/support/database.js';
import { HERMES_REVISION } from '../../test/support/seed.js';
import type { Env } from '../config/env.js';
import { workers } from '../database/schema/index.js';
import { ConfigurationReadsService } from './configuration-reads.service.js';
import { ConfigurationWritesService } from './configuration-writes.service.js';
import { ConfigurationFormOptionsService, mcpEndpoint, sizeLabel } from './form-options.service.js';
import { configurationInput as input, seedLibrary, type Library } from './support-spec.js';

let t: TestDatabase;
let lib: Library;
let dir: string;
let warnings: unknown[];

const service = (pricesFile: string) =>
  new ConfigurationFormOptionsService(
    t.db,
    { get: () => pricesFile } as unknown as ConfigService<Env, true>,
    {
      setContext: () => {},
      warn: (obj: unknown) => warnings.push(obj),
    } as unknown as PinoLogger,
  );

beforeEach(async () => {
  t = await createTestDatabase();
  lib = await seedLibrary(t.db);
  dir = await mkdtemp(join(tmpdir(), 'hermes-evals-form-'));
  warnings = [];
});

afterEach(async () => {
  await t.close();
  await rm(dir, { recursive: true, force: true });
});

describe('form options', () => {
  it('offers priced models, then other models in use; the library; the fallback toolsets', async () => {
    const prices = join(dir, 'prices.yaml');
    await writeFile(
      prices,
      "openai/gpt-6.1-sol:\n  input_per_1m: 0.6\n  output_per_1m: 2.4\n  checked_at: '2026-10-20'\n",
    );
    await new ConfigurationWritesService(t.db).create(input({ model: 'local/llama' }));
    await new ConfigurationWritesService(t.db).create(input({ name: 'priced' }));

    const options = ConfigurationFormOptionsSchema.parse(await service(prices).formOptions());
    expect(options.models).toEqual([
      {
        id: 'openai/gpt-6.1-sol',
        price: { inputPer1M: 0.6, outputPer1M: 2.4, checkedAt: '2026-10-20' },
      },
      { id: 'local/llama', price: null },
    ]);
    expect(options.providers.map((p) => p.label)).toEqual([
      'nous · Nous Portal',
      'nous-api · Nous API key',
      'openrouter · OpenRouter',
      'openai · OpenAI',
      'anthropic · Anthropic',
      'custom · OpenAI-compatible URL',
    ]);
    expect(options.toolsets.map((o) => o.name)).toEqual([...HERMES_TOOLSETS]);
    expect(options.toolsets.filter((o) => o.defaultOn).map((o) => o.name)).toEqual([
      'terminal',
      'file',
    ]);
    expect(options.skills).toEqual([
      expect.objectContaining({
        skillId: lib.skillId,
        name: 'invoice-method',
        version: '1.0.0',
        description: 'Reconcile invoices against the ledger before answering.',
      }),
    ]);
    expect(options.documents).toEqual([
      expect.objectContaining({
        documentId: lib.documentId,
        filename: 'vendor-policy-v3.pdf',
        sizeBytes: 219_136,
        typeLabel: '214 KB',
      }),
    ]);
    // Latest definitions, and no configuration pins invoice-db v1: v2 only.
    expect(options.mcpServers).toEqual([
      {
        mcpServerId: lib.mcpServerId,
        versionId: lib.mcpV2,
        name: 'invoice-db',
        version: 2,
        transport: 'stdio',
        envNames: ['INVOICE_DB_URL'],
        headers: [],
        endpoint: 'invoice-db-mcp --read-only',
        latest: true,
      },
      expect.objectContaining({
        versionId: lib.httpMcpV1,
        name: 'vendor-api',
        transport: 'http',
        envNames: [],
        headers: [{ header: 'Authorization', env: 'VENDOR_API_TOKEN' }],
        endpoint: 'https://vendor-api.example.com/mcp',
        latest: true,
      }),
    ]);
    // Preload first, the default; the form offers the choice once a skill is picked.
    expect(options.skillLoading).toEqual([...SKILL_LOADING_OPTIONS]);
    expect(options.skillLoading.map((o) => [o.id, o.label])).toEqual([
      ['preload', 'preload'],
      ['on_demand', 'on demand'],
    ]);
    expect(warnings).toEqual([]);
  });

  it('also offers an older MCP version a configuration still pins, so its draft resolves', async () => {
    // with-mcp was saved on invoice-db v1; the server has since moved on to v2.
    const saved = await new ConfigurationWritesService(t.db).create(
      input({ name: 'with-mcp', mcpServerVersionIds: [lib.mcpV1] }),
    );
    const options = ConfigurationFormOptionsSchema.parse(
      await service(join(dir, 'missing.yaml')).formOptions(),
    );
    expect(options.mcpServers.map((m) => [m.name, m.version, m.latest])).toEqual([
      ['invoice-db', 2, true],
      ['invoice-db', 1, false],
      ['vendor-api', 1, true],
    ]);
    const draft = await new ConfigurationReadsService(t.db).editDraft(saved.configurationId);
    const offered = new Set(options.mcpServers.map((m) => m.versionId));
    expect(draft.values.mcpServerVersionIds).toEqual([lib.mcpV1]);
    for (const id of draft.values.mcpServerVersionIds) expect(offered.has(id), id).toBe(true);
  });

  it('uses the newest live worker’s toolsets, in its order', async () => {
    const worker = {
      hostname: 'w',
      concurrency: 1,
      hermesVersion: '0.22.4',
      hermesRevision: HERMES_REVISION,
    };
    await t.db.insert(workers).values([
      // Stopped and stale workers do not count, nor does a live one with no list.
      { ...worker, toolsets: ['stopped'], stoppedAt: new Date() },
      { ...worker, toolsets: ['stale'], lastHeartbeatAt: new Date(Date.now() - 120_000) },
      { ...worker, toolsets: ['terminal', 'file', 'web'], startedAt: new Date(Date.now() - 5000) },
      { ...worker, toolsets: [] },
    ]);
    const options = await service(join(dir, 'missing.yaml')).formOptions();
    expect(options.toolsets).toEqual([
      { name: 'terminal', defaultOn: true },
      { name: 'file', defaultOn: true },
      { name: 'web', defaultOn: false },
    ]);
    expect(options.models).toEqual([]);
  });

  it('logs a price file it cannot use and offers no prices', async () => {
    const prices = join(dir, 'prices.yaml');
    await writeFile(prices, 'openai/gpt: nonsense\n');
    const options = await service(prices).formOptions();
    expect(options.models).toEqual([]);
    expect(warnings).toHaveLength(1);
  });
});

describe('a new configuration’s draft', () => {
  it('starts from the first model offered, the default toolsets, 20 turns and 300 s', async () => {
    const prices = join(dir, 'prices.yaml');
    await writeFile(
      prices,
      "mock/scripted:\n  input_per_1m: 0\n  output_per_1m: 0\n  checked_at: '2026-10-24'\n",
    );
    const draft = ConfigurationDraftSchema.parse(await service(prices).newDraft());
    expect(draft).toEqual({
      mode: 'new',
      source: null,
      values: {
        name: '',
        model: 'mock/scripted',
        provider: 'nous',
        baseUrl: null,
        toolsets: ['terminal', 'file'],
        memoryEnabled: false,
        skillIds: [],
        skillLoading: 'preload',
        documentIds: [],
        mcpServerVersionIds: [],
        maxTurns: 20,
        timeBudgetS: 300,
        duplicatedFromVersionId: null,
      },
      createsNewVersion: false,
      nextVersion: null,
      experimentsKeepingVersion: [],
    });
    // Filled in with a name, it saves as it is.
    expect(ConfigurationInputSchema.safeParse({ ...draft.values, name: 'first' }).success).toBe(
      true,
    );
  });

  it('leaves the model empty when nothing is offered', async () => {
    const draft = await service(join(dir, 'missing.yaml')).newDraft();
    expect(draft.values.model).toBe('');
  });
});

describe('display helpers', () => {
  it('formats sizes and endpoints', () => {
    expect(sizeLabel(512)).toBe('512 B');
    expect(sizeLabel(219_136)).toBe('214 KB');
    expect(sizeLabel(3 * 1024 * 1024 + 200_000)).toBe('3.2 MB');
    expect(mcpEndpoint({ command: 'npx', args: ['invoice-db-mcp'], url: null })).toBe(
      'npx invoice-db-mcp',
    );
    expect(mcpEndpoint({ command: 'python3', args: ['/opt/my server.py'], url: null })).toBe(
      'python3 "/opt/my server.py"',
    );
    expect(mcpEndpoint({ command: null, args: [], url: 'https://x.example/mcp' })).toBe(
      'https://x.example/mcp',
    );
  });
});
