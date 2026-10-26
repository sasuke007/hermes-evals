/**
 * The import routes over HTTP: SuiteImportModule on PGlite with a stand-in
 * for the drafts module (DraftImportPort) that keeps drafts in memory and
 * checks that every blob a task names has its row. The readiness rules are
 * the drafts module's; here a stand-in answers from the task's files. Every
 * success body is parsed with its shared schema.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Global, Injectable, Module, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { PinoLogger } from 'nestjs-pino';
import request from 'supertest';
import { parse as parseYaml } from 'yaml';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SuiteDraftViewSchema,
  SuiteZipValidationSchema,
  TaskImportRefusalBodySchema,
  TaskImportResultSchema,
  TaskImportValidationSchema,
  type SuiteDraftView,
} from '@hermes-evals/shared';
import { inArray } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from '../../../test/support/database.js';
import { DB } from '../../database/db.provider.js';
import { blobs, suiteDrafts, suiteSources } from '../../database/schema/index.js';
import { silentLogger } from '../../resources/skills/testing.helper-spec.js';
import { BlobStore } from '../../storage/blob-store.js';
import { StorageService } from '../../storage/storage.service.js';
import type { DraftTaskFolder } from '../drafts/materialise.js';
import type { DraftImportPort, ImportedSuiteDraft } from './draft-import.port.js';
import { SuiteImportModule } from './suite-import.module.js';
import { buildZip, vendorStatements, zipItemsOfFolder } from './zip-testing.helper-spec.js';

vi.mock('../drafts/readiness.js', () => ({
  evaluateReadiness: vi.fn(async (task: DraftTaskFolder) => {
    const yaml = (task.taskYaml ? parseYaml(task.taskYaml) : {}) as {
      summary?: string;
      verification?: unknown[];
    };
    const ok = task.prompt !== null && task.reference !== null;
    return {
      readiness: {
        summary: ok ? 'ready' : 'problems',
        rules: ok ? [] : [{ rule: 'reference_json', status: 'problem', message: '', target: null }],
      },
      analysis: { summary: yaml.summary ?? null, verification: yaml.verification ?? [] },
    };
  }),
}));

const SUITES_DIR = resolve(import.meta.dirname, '../../../../../suites');
const NOW = '2026-10-26T12:00:00.000Z';

/** The drafts module as the import reaches it: drafts in memory, blob rows checked. */
@Injectable()
class FakeDrafts implements DraftImportPort {
  db!: TestDatabase['db'];
  drafts = new Map<string, DraftTaskFolder[]>();
  created: ImportedSuiteDraft[] = [];

  async draftForImport(folder: string) {
    const tasks = this.drafts.get(folder);
    return tasks ? { tasks } : null;
  }

  async addImportedTasks(folder: string, tasks: readonly DraftTaskFolder[]) {
    await this.assertBlobRows(tasks);
    this.drafts.get(folder)!.push(...tasks);
    return viewOf(folder, 'edit', this.drafts.get(folder)!);
  }

  async createImportedSuiteDraft(draft: ImportedSuiteDraft) {
    await this.assertBlobRows(draft.tasks);
    this.created.push(draft);
    this.drafts.set(draft.name, [...draft.tasks]);
    return viewOf(draft.name, 'zip', draft.tasks, draft.versionLabel);
  }

  private async assertBlobRows(tasks: readonly DraftTaskFolder[]) {
    const shas = [...new Set(tasks.flatMap((t) => t.files.map((f) => f.sha256)))];
    if (shas.length === 0) return;
    const rows = await this.db.select().from(blobs).where(inArray(blobs.sha256, shas));
    expect(rows.map((r) => r.sha256).sort()).toEqual(shas.sort());
  }
}

function viewOf(
  folder: string,
  origin: 'edit' | 'zip',
  tasks: readonly DraftTaskFolder[],
  versionLabel = '0.3',
): SuiteDraftView {
  return SuiteDraftViewSchema.parse({
    id: `draft_${folder}`,
    folder,
    path: `./suites/${folder}`,
    name: folder,
    origin,
    base: null,
    nextVersion: 1,
    versionLabel,
    description: null,
    changes: tasks.map((t) => ({ kind: 'added', key: t.key, renamedFrom: null })),
    tasks: [],
    problems: [],
    conflict: null,
    saving: null,
    revision: tasks.length,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

@Module({ providers: [FakeDrafts], exports: [FakeDrafts] })
class FakeDraftsModule {}

let t: TestDatabase;
let store: BlobStore;
let app: INestApplication;
let drafts: FakeDrafts;

beforeAll(async () => {
  t = await createTestDatabase();
  store = new BlobStore(await mkdtemp(join(tmpdir(), 'suite-import-')));
  const env: Record<string, unknown> = { DATA_DIR: store.dataDir, SKILL_UPLOAD_TTL_S: 1800 };

  @Global()
  @Module({
    providers: [
      { provide: DB, useValue: t.db },
      { provide: ConfigService, useValue: { get: (name: string) => env[name] } },
      { provide: PinoLogger, useValue: silentLogger },
    ],
    exports: [DB, ConfigService, PinoLogger],
  })
  class InfraModule {}

  const moduleRef = await Test.createTestingModule({
    imports: [
      InfraModule,
      SuiteImportModule.withDrafts({ imports: [FakeDraftsModule], port: FakeDrafts }),
    ],
  })
    .overrideProvider(StorageService)
    .useValue(store)
    .compile();
  drafts = moduleRef.get(FakeDrafts);
  drafts.db = t.db;
  app = moduleRef.createNestApplication({ logger: false });
  app.setGlobalPrefix('api');
  await app.init();
}, 30_000);

afterAll(async () => {
  await app.close();
  await t.close();
  await rm(store.dataDir, { recursive: true, force: true });
});

const http = () => request(app.getHttpServer());

const INVOICES = { path: 'fixtures/invoices.csv', kind: 'fixture' as const, size: 0, sha256: '' };

beforeEach(async () => {
  const ref = await store.putBuffer(Buffer.from('invoice,amount\nA,1\n'));
  await store.recordBlob(t.db, ref);
  drafts.drafts.set('invoices-v1', [
    {
      key: 'total_due',
      taskYaml: 'summary: Total due\n',
      prompt: 'What is due?\n',
      reference: '{}\n',
      rubrics: {},
      files: [{ ...INVOICES, ...ref }],
    },
  ]);
  drafts.created = [];
});

const CSV = `key,question,expected
overdue_fjord,How many overdue invoices does Fjord Software have?,3
overdue 90,How many invoices are more than 90 days overdue?,1
`;

const SETTINGS = {
  mapping: [
    { column: 'key', use: 'task_key' },
    { column: 'question', use: 'prompt' },
    { column: 'expected', use: 'reference_value' },
  ],
  keyPrefix: null,
  answerPath: 'answer',
  workspace: { from: 'task', key: 'total_due' },
  checks: {
    from: 'new',
    checks: [{ key: 'answer', type: 'numeric_tolerance', primary: true, params: { abs: 0 } }],
  },
  limits: { maxTurns: 20, runBudgetSeconds: 300, toolsetsNeeded: ['file'] },
  appendAnswerInstructions: true,
  keyFixes: [],
};

const postTasks = (path: string, settings: object | string | null, file = CSV, name = 'q.csv') => {
  const req = http().post(`/api/suites/${path}`).attach('file', Buffer.from(file), name);
  if (settings !== null) {
    req.field('settings', typeof settings === 'string' ? settings : JSON.stringify(settings));
  }
  return req;
};

describe('POST /suites/:suite/draft/import/validate', () => {
  it('reads the file alone (step 1)', async () => {
    const res = await postTasks('invoices-v1/draft/import/validate', null).expect(200);
    const body = TaskImportValidationSchema.parse(res.body);
    expect(body.file).toMatchObject({ fileName: 'q.csv', rowCount: 2 });
    expect(body).toMatchObject({ problems: [], preview: null });
  });

  it('previews the tasks with the settings (step 4)', async () => {
    const res = await postTasks('invoices-v1/draft/import/validate', SETTINGS).expect(200);
    const { preview } = TaskImportValidationSchema.parse(res.body);
    expect(preview).toMatchObject({ addCount: 1, fixCount: 1 });
    expect(preview!.rows[1]!.needsFix).toBe(true);
  });

  it('says why a file cannot be imported', async () => {
    const res = await postTasks('invoices-v1/draft/import/validate', null, 'x', 'q.xlsx').expect(
      200,
    );
    expect(TaskImportValidationSchema.parse(res.body)).toMatchObject({
      file: null,
      preview: null,
      problems: [{ title: 'q.xlsx: use CSV or JSONL.' }],
    });
  });

  it.each([
    [
      'invoices-v1/draft/import/validate',
      '{not json',
      400,
      "the field 'settings' is not valid JSON",
    ],
    ['invoices-v1/draft/import/validate', { mapping: [] }, 400, 'Validation failed'],
    [
      'nothing-here/draft/import/validate',
      null,
      404,
      'nothing-here has no open draft; open one before importing tasks',
    ],
    ['bad%20name/draft/import/validate', null, 400, 'bad name is not a suite folder name'],
  ])('refuses %s with %j', async (path, settings, status, message) => {
    const res = await postTasks(path, settings).expect(status);
    expect(res.body).toMatchObject({ statusCode: status, message });
  });
});

describe('POST /suites/:suite/draft/import', () => {
  it('adds nothing while a row needs a fix (422 with the preview)', async () => {
    const res = await postTasks('invoices-v1/draft/import', SETTINGS).expect(422);
    const body = TaskImportRefusalBodySchema.parse(res.body);
    expect(body.message).toBe('1 row needs a fix; nothing was added');
    expect(drafts.drafts.get('invoices-v1')).toHaveLength(1);
  });

  it('adds every row once fixed, with the uploaded workspace files recorded as blobs', async () => {
    const settings = {
      ...SETTINGS,
      workspace: { from: 'upload' },
      keyFixes: [{ row: 2, key: 'overdue_90' }],
    };
    const res = await postTasks('invoices-v1/draft/import', settings)
      .attach('workspace', Buffer.from('ledger\n'), 'ledger.csv')
      .expect(201);
    const body = TaskImportResultSchema.parse(res.body);
    expect(body.added).toEqual(['overdue_fjord', 'overdue_90']);
    const added = drafts.drafts.get('invoices-v1')!.slice(1);
    expect(added.map((t) => t.files.map((f) => f.path))).toEqual([
      ['fixtures/ledger.csv'],
      ['fixtures/ledger.csv'],
    ]);
    expect(added[0]!.reference).toBe('{\n  "answer": 3\n}\n');
  });

  it('refuses a workspace file the loader would skip', async () => {
    const res = await postTasks('invoices-v1/draft/import', {
      ...SETTINGS,
      workspace: { from: 'upload' },
    })
      .attach('workspace', Buffer.from('x'), '.env')
      .expect(400);
    expect(res.body.message).toBe(
      'workspace file fixtures/.env: names starting with . are skipped by the loader',
    );
  });

  it('needs the settings', async () => {
    const res = await postTasks('invoices-v1/draft/import', null).expect(400);
    expect(res.body.message).toBe("send the import settings as JSON in the field 'settings'");
  });
});

const postZip = async (zip: Buffer, name = 'suite.zip') =>
  SuiteZipValidationSchema.parse(
    (await http().post('/api/suites/import/validate').attach('file', zip, name).expect(200)).body,
  );

describe('POST /suites/import/validate, then POST /suites/import', () => {
  it('imports a zip without scripts as a new draft, without the trust tick', async () => {
    const validation = await postZip(
      await buildZip(vendorStatements()),
      'vendor-statements-v1.zip',
    );
    expect(validation).toMatchObject({
      outcome: 'valid',
      fileName: 'vendor-statements-v1.zip',
      suite: { name: 'vendor-statements-v1', versionLabel: '0.1' },
      nameTaken: null,
      scripts: [],
      tasks: [
        {
          key: 'unmatched_lines',
          summary: 'Lines of the statement missing from the ledger',
          readiness: 'ready',
          problem: null,
          workspaceFiles: 2,
          checks: 1,
        },
      ],
    });
    const res = await http()
      .post('/api/suites/import')
      .send({ token: validation.token, name: 'vendor-statements-v1', trustScripts: false })
      .expect(201);
    expect(SuiteDraftViewSchema.parse(res.body)).toMatchObject({
      folder: 'vendor-statements-v1',
      origin: 'zip',
    });
    expect(drafts.created[0]).toMatchObject({
      name: 'vendor-statements-v1',
      scriptsTrusted: false,
    });
    // The token is spent.
    await http()
      .post('/api/suites/import')
      .send({ token: validation.token, name: 'vendor-statements-v1', trustScripts: false })
      .expect(404);
  });

  it('rejects a zip a reload would refuse, with no token', async () => {
    const zip = await buildZip(
      vendorStatements('', [{ path: 'total_due/fixtures/data.csv', content: 'x', mode: 0o120777 }]),
    );
    expect(await postZip(zip)).toMatchObject({
      outcome: 'rejected',
      token: null,
      problems: [{ title: 'The zip has a symbolic link at total_due/fixtures/data.csv.' }],
    });
  });

  it('suggests a free name when the name is taken, and refuses to import under it', async () => {
    await t.db.insert(suiteSources).values({
      path: 'vendor-statements-v1',
      name: 'vendor-statements-v1',
      lastOutcome: 'error',
      lastError: { file: 'suite.yaml', line: null, column: null, message: 'x', excerpt: null },
    });
    await t.db.insert(suiteDrafts).values({
      sourcePath: 'vendor-statements-v1-copy',
      name: 'vendor-statements-v1-copy',
      origin: 'empty',
      versionLabel: '0.1',
    });
    const validation = await postZip(await buildZip(vendorStatements()));
    expect(validation).toMatchObject({
      outcome: 'name_taken',
      nameTaken: {
        path: './suites/vendor-statements-v1',
        suggestion: 'vendor-statements-v1-copy-2',
      },
    });
    const taken = await http()
      .post('/api/suites/import')
      .send({ token: validation.token, name: 'vendor-statements-v1-copy', trustScripts: false })
      .expect(409);
    expect(taken.body.message).toBe(
      'vendor-statements-v1-copy is already used by ./suites/vendor-statements-v1-copy.',
    );
    await http()
      .post('/api/suites/import')
      .send({ token: validation.token, name: 'vendor-statements-v1-copy-2', trustScripts: false })
      .expect(201);
  });

  it('answers 410 for an expired token, 404 for an unknown one', async () => {
    const validation = await postZip(await buildZip(vendorStatements()));
    const manifest = join(
      store.dataDir,
      'tmp',
      'suite-imports',
      validation.token!,
      'manifest.json',
    );
    const json = JSON.parse(await readFile(manifest, 'utf8')) as { expiresAt: string };
    await writeFile(manifest, JSON.stringify({ ...json, expiresAt: '2020-01-01T00:00:00.000Z' }));
    const body = { name: 'whatever-v1', trustScripts: false };
    await http()
      .post('/api/suites/import')
      .send({ ...body, token: validation.token })
      .expect(410);
    await http()
      .post('/api/suites/import')
      .send({ ...body, token: 'f'.repeat(64) })
      .expect(404);
    await http()
      .post('/api/suites/import')
      .send({ ...body, token: '../x' })
      .expect(404);
  });
});

describe.each([
  ['invoices-v1', true],
  ['memory-v1', true],
  ['tools-v1', true],
  ['mcp-v1', false],
  ['knowledge-v1', false],
])('the committed suite %s as a zip', (suite, hasScripts) => {
  it(
    hasScripts ? 'imports only with the trust tick' : 'imports without the trust tick',
    async () => {
      const zip = await buildZip(await zipItemsOfFolder(join(SUITES_DIR, suite), `${suite}/`));
      const validation = await postZip(zip, `${suite}-v1.zip`);
      expect(validation.outcome).toBe('valid');
      expect(validation.scripts.length > 0).toBe(hasScripts);
      for (const script of validation.scripts) expect(script.path).toMatch(/^[^/]+\/verify\//);
      const name = `zz-smoke-${suite}`;
      if (hasScripts) {
        const refused = await http()
          .post('/api/suites/import')
          .send({ token: validation.token, name, trustScripts: false })
          .expect(409);
        expect(refused.body).toEqual({
          statusCode: 409,
          message: 'Confirm the verifier scripts first.',
        });
      }
      await http()
        .post('/api/suites/import')
        .send({ token: validation.token, name, trustScripts: hasScripts })
        .expect(201);
      const created = drafts.created.at(-1)!;
      expect(created).toMatchObject({ name, scriptsTrusted: hasScripts });
      expect(created.tasks.map((t) => t.key)).toEqual(validation.tasks.map((t) => t.key));
      expect(created.suiteYaml).toBe(await readFile(join(SUITES_DIR, suite, 'suite.yaml'), 'utf8'));
    },
  );
});
