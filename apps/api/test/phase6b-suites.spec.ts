/**
 * The repository's five sample suites together (Phase 6b exit; plan 18.5
 * step 1): suites/ loaded in one pass by the real loader, as POST
 * /suites/reload runs it in the worker, with one 3,600 s self-check budget
 * for the whole pass (plan 4.4), into one PGlite. Every suite is created
 * with every task valid and no load issue at all, every runnable self-check
 * passes on its reference and every negative control fails. Then every
 * resource a recommended arm needs: each skill under samples/skills, zipped
 * as a user zips it, validates and is stored; each document under
 * samples/documents/<suite> uploads under its own name, and its suite's
 * description names the folder.
 */
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import request from 'supertest';
import { parse } from 'yaml';
import { z } from 'zod';
import {
  DocumentRowSchema,
  LoadIssueSchema,
  SelfCheckSchema,
  SkillRowSchema,
  SkillUploadValidationSchema,
  SuiteReloadResultSchema,
  type SuiteReloadResult,
} from '@hermes-evals/shared';
import { tasks } from '../src/database/schema/index.js';
import { MAX_LOAD_SELF_CHECK_SECONDS } from '../src/queue/queues.js';
import { buildZip, startResourcesApp } from '../src/resources/skills/testing.helper-spec.js';
import { BlobStore } from '../src/storage/blob-store.js';
import { SuiteLoader, type LoaderLogger } from '../src/suites/loader/suite-loader.js';
import { createTestDatabase, type TestDatabase } from './support/database.js';
import { listFiles, readText, REPO, SUITES_DIR } from './invoices-v1/support.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 600_000 });

/** Every suite directory, with its task count (plan 18.1 and 18.3). */
const SUITES: Record<string, number> = {
  'invoices-v1': 12,
  'knowledge-v1': 8,
  'mcp-v1': 8,
  'memory-v1': 8,
  'tools-v1': 6,
};
/** The checks that run twice, the second time as a negative control that must fail. */
const NEGATIVE_CONTROLS: Record<string, string[]> = {
  'invoices-v1': ['summary_file.summary_csv', 'summary_file.totals'],
  'knowledge-v1': [],
  'mcp-v1': [],
  'memory-v1': ['remember_this.saved'],
  'tools-v1': ['reshape_json.stock_file', 'reshape_json.quantities'],
};
const SuiteYamlSchema = z.object({
  name: z.string(),
  description: z.string(),
  tasks: z.array(z.string()),
});
const silent = { info: () => {}, warn: () => {}, error: () => {} } as unknown as LoaderLogger;

type TaskRow = typeof tasks.$inferSelect;

let db: TestDatabase;
let root: string;
let result: SuiteReloadResult;
const rows = new Map<string, TaskRow[]>();
const yamls = new Map<string, z.infer<typeof SuiteYamlSchema>>();

beforeAll(async () => {
  db = await createTestDatabase();
  root = await mkdtemp(join(tmpdir(), 'phase6b-suites-'));
  const loader = new SuiteLoader({
    db: db.db,
    blobs: new BlobStore(join(root, 'data')),
    suitesDir: SUITES_DIR,
    logger: silent,
  });
  result = SuiteReloadResultSchema.parse(
    await loader.loadAll({ selfCheckBudgetS: MAX_LOAD_SELF_CHECK_SECONDS }),
  );
  for (const entry of result.suites) {
    if (entry.suiteId === null) continue;
    const loaded = await db.db
      .select()
      .from(tasks)
      .where(eq(tasks.suiteId, entry.suiteId))
      .orderBy(asc(tasks.position));
    rows.set(entry.name, loaded);
  }
  for (const name of Object.keys(SUITES)) {
    yamls.set(name, SuiteYamlSchema.parse(parse(await readText(SUITES_DIR, name, 'suite.yaml'))));
  }
});

afterAll(async () => {
  await db?.close();
  await rm(root, { recursive: true, force: true });
});

const each = () => Object.keys(SUITES);

describe('suites/, loaded in one pass', () => {
  it('holds exactly the five sample suites', async () => {
    const dirs = (await readdir(SUITES_DIR, { withFileTypes: true }))
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name)
      .sort();
    expect(dirs).toEqual(each());
  });

  it('creates every suite, each under its directory name, within one reload budget', () => {
    expect(result.suites.map((s) => [s.name, s.outcome, s.versionNumber, s.error])).toEqual(
      each().map((name) => [name, 'created', 1, null]),
    );
  });

  it.each(each())(
    '%s: every task in suite.yaml order, valid, with no load issue at all',
    (name) => {
      const loaded = rows.get(name)!;
      expect(loaded.map((r) => r.key)).toEqual(yamls.get(name)!.tasks);
      expect(loaded).toHaveLength(SUITES[name]!);
      for (const r of loaded) {
        expect(r, `${name}/${r.key}`).toMatchObject({ valid: true, invalidReason: null });
        for (const issue of r.loadIssues) LoadIssueSchema.parse(issue);
        expect(r.loadIssues, `${name}/${r.key}`).toEqual([]);
      }
    },
  );

  it.each(each())(
    '%s: every runnable self-check passes, every negative control fails, only trajectory and judge keys are skipped',
    (name) => {
      const negatives: string[] = [];
      for (const r of rows.get(name)!) {
        const check = SelfCheckSchema.parse(r.selfCheck);
        expect(check.status, `${name}/${r.key}`).toBe('passed');
        for (const res of check.results) {
          const where = `${name}/${r.key}.${res.key}: ${res.comment}`;
          if (res.mode === 'none') {
            expect(['trajectory_match', 'llm_judge'], where).toContain(res.type);
            expect(res.status, where).toBe('skipped');
          } else if (res.expect === 'fail') {
            negatives.push(`${r.key}.${res.key}`);
            expect(res.status, where).toBe('failed');
          } else {
            expect(res.status, where).toBe('passed');
          }
        }
      }
      expect(negatives).toEqual(NEGATIVE_CONTROLS[name]);
    },
  );

  it('loads 42 tasks in all, every one selectable for an experiment', () => {
    const all = [...rows.values()].flat();
    expect(all).toHaveLength(42);
    expect(all.every((r) => r.valid)).toBe(true);
  });
});

describe('the resources of the recommended arms', () => {
  let t: TestDatabase;
  let dataDir: string;
  let app: INestApplication;

  beforeAll(async () => {
    t = await createTestDatabase();
    dataDir = await mkdtemp(join(tmpdir(), 'phase6b-resources-'));
    app = await startResourcesApp(t.db, dataDir);
  });

  afterAll(async () => {
    await app?.close();
    await t?.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const SKILLS_DIR = join(REPO, 'samples/skills');
  const DOCUMENTS_DIR = join(REPO, 'samples/documents');

  it('every skill under samples/skills validates as a new skill and is stored on confirm', async () => {
    const names = (await readdir(SKILLS_DIR)).sort();
    expect(names).toEqual(['bx6-format', 'bx7-format', 'house-style', 'invoice-method']);
    for (const name of names) {
      const dir = join(SKILLS_DIR, name);
      const files = await listFiles(dir);
      const zip = await buildZip(
        await Promise.all(
          files.map(async (path) => ({ path, content: await readFile(join(dir, path)) })),
        ),
      );
      const validated = await request(app.getHttpServer())
        .post('/api/resources/skills/validate')
        .attach('file', zip, { filename: `${name}.zip`, contentType: 'application/zip' })
        .expect(200);
      const report = SkillUploadValidationSchema.parse(validated.body);
      expect(report, name).toMatchObject({ outcome: 'valid', name, problems: [], existing: null });
      expect(
        report.checks.every((c) => c.ok),
        name,
      ).toBe(true);
      expect(
        report.fileTree.map((f) => f.path),
        name,
      ).toEqual(files);
      const stored = await request(app.getHttpServer())
        .post('/api/resources/skills')
        .send({ token: report.token })
        .expect(201);
      expect(SkillRowSchema.parse(stored.body), name).toMatchObject({
        name,
        version: report.version,
      });
    }
  });

  it("every document set is named in its suite's description and uploads file by file", async () => {
    const sets = (await readdir(DOCUMENTS_DIR)).sort();
    expect(sets).toEqual(['knowledge-v1', 'mcp-v1']);
    for (const suite of sets) {
      expect(yamls.get(suite)!.description.replace(/\s+/g, ' '), suite).toContain(
        `samples/documents/${suite}`,
      );
      for (const file of await listFiles(join(DOCUMENTS_DIR, suite))) {
        const content = await readFile(join(DOCUMENTS_DIR, suite, file));
        const created = await request(app.getHttpServer())
          .post('/api/resources/documents')
          .attach('file', content, { filename: file })
          .expect(201);
        expect(DocumentRowSchema.parse(created.body), `${suite}/${file}`).toMatchObject({
          filename: file,
          sizeBytes: content.length,
        });
      }
    }
  });
});
