/**
 * The loader end to end on PGlite (real migrations and triggers) with the
 * fixture suites in test/fixtures/suites, copied into a fresh SUITES_DIR per
 * test so edits never leak. Verifier self-checks run python3.
 */
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asc, count, eq } from 'drizzle-orm';
import {
  LoadIssueSchema,
  SelfCheckSchema,
  SuiteChangesSchema,
  SuiteReloadResultSchema,
  type SuiteReloadEntry,
} from '@hermes-evals/shared';
import { blobs, suiteSources, suites, taskFiles, tasks } from '../../database/schema/index.js';
import { BlobStore } from '../../storage/blob-store.js';
import { createTestDatabase, type TestDatabase } from '../../../test/support/database.js';
import { LOADER_VERSION } from './limits.js';
import { SuiteLoader, type LoaderLogger } from './suite-loader.js';

const FIXTURES = join(import.meta.dirname, '../../../test/fixtures/suites');

/** A hook a test can run right after SUITES_DIR is listed, to change the disk mid-pass. */
const hooks = vi.hoisted(() => ({ afterList: null as null | (() => Promise<void>) }));
vi.mock('./walk.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./walk.js')>();
  return {
    ...actual,
    listSuitesDir: async (dir: string) => {
      const listing = await actual.listSuitesDir(dir);
      const hook = hooks.afterList;
      hooks.afterList = null;
      if (hook) await hook();
      return listing;
    },
  };
});

// Each test runs several loads with python verifiers; give them room when every spec runs at once.
vi.setConfig({ testTimeout: 60_000 });
const REAL_SUITES = join(import.meta.dirname, '../../../../../suites');

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as LoaderLogger;

let t: TestDatabase;
let root: string;
let suitesDir: string;
let store: BlobStore;

beforeEach(async () => {
  t = await createTestDatabase();
  root = await mkdtemp(join(tmpdir(), 'hermes-evals-loader-'));
  suitesDir = join(root, 'suites');
  await cp(FIXTURES, suitesDir, { recursive: true });
  store = new BlobStore(join(root, 'data'));
}, 30_000);

afterEach(async () => {
  hooks.afterList = null;
  await t.close();
  await rm(root, { recursive: true, force: true });
});

// no-suite-yaml is read twice on every load; the wait between is suite-loader-retry.spec.ts's.
const loader = (loaderVersion = LOADER_VERSION) =>
  new SuiteLoader({
    db: t.db,
    blobs: store,
    suitesDir,
    logger,
    loaderVersion,
    suiteYamlRetryMs: 0,
  });

/** Loads one directory and checks the result against the shared contract. */
async function load(path: string, l = loader()): Promise<SuiteReloadEntry> {
  const result = SuiteReloadResultSchema.parse(await l.loadOne(path));
  expect(result.suites).toHaveLength(1);
  return result.suites[0]!;
}

async function source(path: string) {
  const [row] = await t.db.select().from(suiteSources).where(eq(suiteSources.path, path));
  return row!;
}

async function taskRows(suiteId: string) {
  return t.db.select().from(tasks).where(eq(tasks.suiteId, suiteId)).orderBy(asc(tasks.position));
}

const edit = async (path: string, change: (text: string) => string) => {
  const file = join(suitesDir, path);
  await writeFile(file, change(await readFile(file, 'utf8')));
};

describe('a suite using every scorer type', () => {
  it('loads v1 with every task valid and every self-check recorded', async () => {
    const entry = await load('complete');
    expect(entry).toMatchObject({
      sourcePath: './suites/complete',
      name: 'complete',
      outcome: 'created',
      versionNumber: 1,
      message: 'All 5 self-checks passed',
      error: null,
    });
    expect(entry.changes.added).toEqual([
      'numeric',
      'json_unordered',
      'exact',
      'summary_file',
      'answer_verifier',
    ]);

    const [suite] = await t.db.select().from(suites).where(eq(suites.id, entry.suiteId!));
    expect(suite).toMatchObject({
      versionNumber: 1,
      versionLabel: '1.0',
      taskCount: 5,
      validCount: 5,
    });
    expect((await source('complete')).currentSuiteId).toBe(suite!.id);

    const rows = await taskRows(suite!.id);
    for (const row of rows) {
      SelfCheckSchema.parse(row.selfCheck);
      for (const issue of row.loadIssues) LoadIssueSchema.parse(issue);
      expect(row, row.key).toMatchObject({ valid: true, invalidReason: null, versionNumber: 1 });
      expect(row.introducedInSuiteId).toBe(suite!.id);
      expect(row.selfCheck.status).toBe('passed');
    }
    const byKey = new Map(rows.map((r) => [r.key, r]));
    const modes = (key: string) =>
      byKey.get(key)!.selfCheck.results.map((r) => [r.key, r.mode, r.expect ?? null, r.status]);

    // answer.path applied to the primary that names no path.
    expect(byKey.get('numeric')!.verification[0]!.params).toEqual({ abs: 0.01, path: 'total' });
    expect(modes('numeric')).toEqual([['answer', 'answer', null, 'passed']]);
    expect(modes('json_unordered')).toEqual([
      ['answer', 'answer', null, 'passed'],
      ['reads_fixture', 'none', null, 'skipped'],
    ]);
    expect(modes('exact')).toEqual([
      ['answer', 'answer', null, 'passed'],
      ['method', 'none', null, 'skipped'],
    ]);
    expect(modes('summary_file')).toEqual([
      ['summary_csv', 'workspace', 'pass', 'passed'],
      ['summary_csv', 'workspace', 'fail', 'failed'],
      ['totals', 'workspace', 'pass', 'passed'],
      ['totals', 'workspace', 'fail', 'failed'],
    ]);
    expect(modes('answer_verifier')).toEqual([['count', 'script', null, 'passed']]);

    const script = byKey.get('answer_verifier')!.selfCheck.results[0]!;
    expect(script.exit_code).toBe(0);
    expect(script.argv?.slice(2, 3)).toEqual(['--answer']);
    expect(script.argv?.join(' ')).not.toContain(suitesDir);
    expect(byKey.get('summary_file')!.selfCheck.expected_workspace).toEqual([
      { path: 'summary.csv', sha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
    ]);

    const files = await t.db
      .select({
        key: tasks.key,
        path: taskFiles.path,
        kind: taskFiles.kind,
        sha256: taskFiles.sha256,
      })
      .from(taskFiles)
      .innerJoin(tasks, eq(tasks.id, taskFiles.taskId))
      .where(eq(tasks.suiteId, suite!.id))
      .orderBy(asc(tasks.key), asc(taskFiles.path));
    expect(files.map((f) => [f.key, f.path, f.kind])).toEqual([
      ['answer_verifier', 'fixtures/rows.csv', 'fixture'],
      ['answer_verifier', 'verify/check_count.py', 'verifier'],
      ['exact', 'rubric.md', 'rubric'],
      ['json_unordered', 'fixtures/items.csv', 'fixture'],
      ['numeric', 'fixtures/amounts.csv', 'fixture'],
      ['summary_file', 'expected/summary.csv', 'expected'],
      ['summary_file', 'fixtures/invoices.csv', 'fixture'],
      ['summary_file', 'verify/check_summary.py', 'verifier'],
    ]);
    // Every file is in the blob store with its row, byte for byte.
    for (const f of files) {
      expect(await store.read(f.sha256)).toEqual(
        await readFile(join(suitesDir, 'complete', f.key, f.path)),
      );
      const [blob] = await t.db.select().from(blobs).where(eq(blobs.sha256, f.sha256));
      expect(blob).toBeDefined();
    }
    // The self-checks ran on scratch copies, and none is left behind.
    expect(await readdir(store.tmpRoot)).toEqual([]);
  });

  it('reuses the version when nothing changed', async () => {
    const first = await load('complete');
    const second = await load('complete');
    expect(second).toMatchObject({
      outcome: 'unchanged',
      suiteId: first.suiteId,
      versionNumber: 1,
      message: 'Unchanged since v1',
    });
    expect(await t.db.select().from(suites)).toHaveLength(1);
    expect((await source('complete')).lastOutcome).toBe('unchanged');
  });

  it('bumps only the edited task, and a revert points back at v1', async () => {
    const v1 = await load('complete');
    const original = await readFile(join(suitesDir, 'complete/numeric/prompt.md'), 'utf8');
    await edit('complete/numeric/prompt.md', (text) => `${text}\nRound to the cent.\n`);

    const v2 = await load('complete');
    expect(v2).toMatchObject({
      outcome: 'created',
      versionNumber: 2,
      message: '1 task changed: numeric · all self-checks passed',
    });
    expect(v2.changes).toEqual({
      added: [],
      removed: [],
      changed: ['numeric'],
      nowInvalid: [],
      nowValid: [],
    });
    SuiteChangesSchema.parse((await source('complete')).lastChanges);

    const rows = await taskRows(v2.suiteId!);
    for (const row of rows) {
      if (row.key === 'numeric') {
        expect(row).toMatchObject({ versionNumber: 2, introducedInSuiteId: v2.suiteId });
      } else {
        expect(row, row.key).toMatchObject({ versionNumber: 1, introducedInSuiteId: v1.suiteId });
      }
    }

    await writeFile(join(suitesDir, 'complete/numeric/prompt.md'), original);
    const reverted = await load('complete');
    expect(reverted).toMatchObject({
      outcome: 'reverted',
      suiteId: v1.suiteId,
      versionNumber: 1,
      message: 'Reverted to v1',
    });
    expect(reverted.changes.changed).toEqual(['numeric']);
    expect((await source('complete')).currentSuiteId).toBe(v1.suiteId);

    // Editing again to the v2 content reuses v2 and its task numbers.
    await edit('complete/numeric/prompt.md', (text) => `${text}\nRound to the cent.\n`);
    expect(await load('complete')).toMatchObject({ outcome: 'reverted', versionNumber: 2 });
    expect(await t.db.select().from(suites)).toHaveLength(2);
  });

  it('re-checks the same files under a new loader version as a new version', async () => {
    const v1 = await load('complete');
    const v2 = await load('complete', loader(LOADER_VERSION + 1));
    expect(v2).toMatchObject({
      outcome: 'created',
      versionNumber: 2,
      message: 'Same files as v1, re-checked · all self-checks passed',
    });
    const rows = await t.db.select().from(suites).orderBy(asc(suites.versionNumber));
    expect(rows.map((r) => r.contentHash)).toEqual([rows[0]!.contentHash, rows[0]!.contentHash]);
    expect(rows[0]!.checkHash).not.toBe(rows[1]!.checkHash);
    for (const row of await taskRows(v2.suiteId!)) {
      expect(row, row.key).toMatchObject({ versionNumber: 1, introducedInSuiteId: v1.suiteId });
    }
  });

  it('marks a vanished directory missing and keeps its pointer', async () => {
    const all = SuiteReloadResultSchema.parse(await loader().loadAll());
    expect(all.suites.map((s) => [s.sourcePath, s.outcome, s.message])).toEqual([
      ['./suites/complete', 'created', 'All 5 self-checks passed'],
      [
        './suites/mixed',
        'created',
        '3 tasks now invalid: bad_params, failing_verifier, passes_anything',
      ],
      ['./suites/no-suite-yaml', 'error', 'Could not reload: suite.yaml not found'],
    ]);
    const before = await source('complete');
    await rm(join(suitesDir, 'complete'), { recursive: true });

    const again = SuiteReloadResultSchema.parse(await loader().loadAll());
    const complete = again.suites.find((s) => s.sourcePath === './suites/complete')!;
    expect(complete).toMatchObject({
      outcome: 'missing',
      message: 'Missing from disk',
      suiteId: null,
    });
    const after = await source('complete');
    expect(after).toMatchObject({
      lastOutcome: 'missing',
      currentSuiteId: before.currentSuiteId,
      lastError: null,
    });
    // Already missing: the next pass does not report it again.
    const third = SuiteReloadResultSchema.parse(await loader().loadAll());
    expect(third.suites.map((s) => s.sourcePath)).toEqual([
      './suites/mixed',
      './suites/no-suite-yaml',
    ]);
    // The released name can be taken by another directory.
    await cp(join(FIXTURES, 'complete'), join(suitesDir, 'renamed'), { recursive: true });
    expect(await load('renamed')).toMatchObject({ outcome: 'created', name: 'complete' });
  });

  it('gives the second directory declaring a name an error, not a crash', async () => {
    await cp(join(suitesDir, 'complete'), join(suitesDir, 'complete-copy'), { recursive: true });
    const result = SuiteReloadResultSchema.parse(await loader().loadAll());
    const first = result.suites.find((s) => s.sourcePath === './suites/complete')!;
    const second = result.suites.find((s) => s.sourcePath === './suites/complete-copy')!;
    expect(first.outcome).toBe('created');
    expect(second).toMatchObject({ outcome: 'error', suiteId: null, versionNumber: null });
    expect(second.message).toBe(
      'Could not reload: suite.yaml:1:1 · suite name complete is already used by directory complete; give one of them another name',
    );
    expect(second.error).toMatchObject({ file: 'suite.yaml', line: 1, column: 1 });
    expect(await source('complete-copy')).toMatchObject({
      lastOutcome: 'error',
      name: null,
      currentSuiteId: null,
    });
  });
});

describe('invalid tasks', () => {
  it('stores them invalid with their reasons without failing the suite', async () => {
    const entry = await load('mixed');
    expect(entry).toMatchObject({ outcome: 'created', versionNumber: 1 });
    expect(entry.changes.nowInvalid).toEqual(['bad_params', 'failing_verifier', 'passes_anything']);
    expect(entry.message).toBe(
      '3 tasks now invalid: bad_params, failing_verifier, passes_anything',
    );
    const [suite] = await t.db.select().from(suites).where(eq(suites.id, entry.suiteId!));
    expect(suite).toMatchObject({ versionLabel: '2', taskCount: 4, validCount: 1 });
    const byKey = new Map((await taskRows(entry.suiteId!)).map((r) => [r.key, r]));

    expect(byKey.get('good')).toMatchObject({ valid: true });

    const badParams = byKey.get('bad_params')!;
    expect(badParams.valid).toBe(false);
    expect(badParams.selfCheck).toMatchObject({ status: 'skipped', ran_at: null, results: [] });
    expect(badParams.loadIssues).toContainEqual(
      expect.objectContaining({
        severity: 'error',
        code: 'params_invalid',
        key: 'answer',
        path: 'task.yaml#verification[0].params.pass_at',
      }),
    );
    expect(badParams.loadIssues).toContainEqual(
      expect.objectContaining({ severity: 'warning', code: 'prompt_no_fenced_json' }),
    );
    expect(badParams.invalidReason).toMatch(/^answer: params\.pass_at: .*\(line 14\)$/);

    const failing = byKey.get('failing_verifier')!;
    expect(failing.selfCheck.status).toBe('failed');
    expect(failing.selfCheck.results[0]).toMatchObject({
      mode: 'script',
      status: 'failed',
      score: 0.2,
    });
    expect(failing.invalidReason).toMatch(/^check \(verifier_script\) self-check failed: /);

    const anything = byKey.get('passes_anything')!;
    expect(anything.selfCheck.status).toBe('failed');
    expect(anything.selfCheck.results.map((r) => [r.expect, r.status])).toEqual([
      ['pass', 'passed'],
      ['fail', 'passed'],
    ]);
    expect(anything.invalidReason).toBe(
      'output: the check passes on the untouched fixtures, so it would pass any agent',
    );
  });

  it('reports links, special files and missing listed folders as issues', async () => {
    const dir = join(suitesDir, 'complete');
    await symlink('/etc/hosts', join(dir, 'numeric/fixtures/hosts'));
    await symlink('/etc', join(dir, 'exact/notes'));
    await edit('complete/suite.yaml', (text) =>
      text.replace('answer_verifier]', 'answer_verifier, ghost]'),
    );
    const entry = await load('complete');
    expect(entry.changes.nowInvalid).toEqual(['numeric', 'ghost']);
    const byKey = new Map((await taskRows(entry.suiteId!)).map((r) => [r.key, r]));
    expect(byKey.get('numeric')!.loadIssues).toContainEqual({
      severity: 'error',
      code: 'unsafe_file',
      path: 'fixtures/hosts',
      message: 'fixtures/hosts is a symbolic link; the loader never follows links',
    });
    // A link where nothing reads files only warns.
    expect(byKey.get('exact')).toMatchObject({ valid: true });
    expect(byKey.get('exact')!.loadIssues).toContainEqual(
      expect.objectContaining({ severity: 'warning', code: 'unsafe_file', path: 'notes' }),
    );
    expect(byKey.get('ghost')).toMatchObject({
      valid: false,
      position: 5,
      invalidReason: 'task folder ghost/ is listed in suite.yaml but not found',
      prompt: null,
      reference: null,
    });
  });
});

describe('a suite.yaml that does not parse', () => {
  // Written by the test: a fixture file that does not parse would break the repository's format check.
  const BROKEN =
    "name: broken\nversion_label: '0.1'\ndescription: the next line does not parse\ntasks: [only\nother: true\n";

  it('fails the directory with the line, column and the lines around it', async () => {
    await cp(join(FIXTURES, 'no-suite-yaml'), join(suitesDir, 'broken'), { recursive: true });
    await writeFile(join(suitesDir, 'broken/suite.yaml'), BROKEN);
    const entry = await load('broken');
    expect(entry).toMatchObject({
      outcome: 'error',
      name: 'broken',
      suiteId: null,
      versionNumber: null,
    });
    expect(entry.error).toMatchObject({ file: 'suite.yaml', line: 5, column: 1 });
    expect(entry.message).toBe(`Could not reload: suite.yaml:5:1 · ${entry.error!.message}`);
    expect(entry.error!.excerpt).toEqual([
      { line: 3, text: 'description: the next line does not parse', highlight: false },
      { line: 4, text: 'tasks: [only', highlight: false },
      { line: 5, text: 'other: true', highlight: true },
      { line: null, text: '^', highlight: false },
    ]);
    const row = await source('broken');
    expect(row).toMatchObject({
      lastOutcome: 'error',
      currentSuiteId: null,
      name: null,
      lastChanges: null,
    });
    expect(row.lastError).toEqual({
      file: 'suite.yaml',
      line: 5,
      column: 1,
      message: entry.error!.message,
      excerpt:
        '  3 | description: the next line does not parse\n  4 | tasks: [only\n> 5 | other: true\n^',
    });
  });

  it('fails a directory without suite.yaml', async () => {
    const entry = await load('no-suite-yaml');
    expect(entry).toMatchObject({
      outcome: 'error',
      message: 'Could not reload: suite.yaml not found',
      error: { file: 'suite.yaml', line: null, column: null, excerpt: [] },
    });
  });

  it('keeps the last good version current', async () => {
    const good = await load('complete');
    await edit('complete/suite.yaml', (text) =>
      text.replace('version_label', 'version_label: [\n'),
    );
    const broken = await load('complete');
    expect(broken.outcome).toBe('error');
    expect(await source('complete')).toMatchObject({
      lastOutcome: 'error',
      currentSuiteId: good.suiteId,
      name: 'complete',
    });
    // Fixing it again finds the version still current.
    await cp(join(FIXTURES, 'complete/suite.yaml'), join(suitesDir, 'complete/suite.yaml'));
    expect(await load('complete')).toMatchObject({ outcome: 'unchanged', suiteId: good.suiteId });
  });
});

describe('the real invoices-v1 suite', () => {
  it('loads every task valid, with every self-check passed', async () => {
    await cp(join(REAL_SUITES, 'invoices-v1'), join(suitesDir, 'invoices-v1'), { recursive: true });
    const entry = await load('invoices-v1');
    expect(entry).toMatchObject({ outcome: 'created', name: 'invoices-v1', versionNumber: 1 });
    const rows = await taskRows(entry.suiteId!);
    expect(
      rows.filter((task) => !task.valid).map((task) => [task.key, task.invalidReason]),
    ).toEqual([]);
    expect(rows.map((task) => [task.key, task.selfCheck.status])).toEqual(
      rows.map((task) => [task.key, 'passed']),
    );
    // The reference is the generator's (scripts/fixtures/invoices-v1.ts), stored as written.
    const totalDue = rows.find((task) => task.key === 'total_due');
    const reference: unknown = JSON.parse(
      await readFile(join(REAL_SUITES, 'invoices-v1/total_due/reference.json'), 'utf8'),
    );
    expect(totalDue?.reference).toEqual(reference);
  });
});

describe('a task.yaml that does not parse', () => {
  it('fails the reload and keeps serving the last good version', async () => {
    const v1 = await load('complete');
    await edit('complete/numeric/task.yaml', (text) =>
      text.replace('params: { abs: 0.01 }', 'params: abs: 0.01'),
    );
    const broken = await load('complete');
    expect(broken).toMatchObject({
      outcome: 'error',
      name: 'complete',
      suiteId: null,
      versionNumber: null,
      error: { file: 'numeric/task.yaml', line: 13, column: 13 },
    });
    expect(broken.error!.excerpt).toContainEqual({
      line: 13,
      text: '    params: abs: 0.01',
      highlight: true,
    });
    expect(broken.message).toBe(
      `Could not reload: numeric/task.yaml:13:13 · ${broken.error!.message}`,
    );
    expect(await source('complete')).toMatchObject({
      lastOutcome: 'error',
      currentSuiteId: v1.suiteId,
      name: 'complete',
    });
    expect(await t.db.select().from(suites)).toHaveLength(1);
  });
});

describe('loads that overlap', () => {
  it('serves what is on disk when a slow load and a reload of the edit overlap', async () => {
    // A verifier that takes a while, as one near its 30 s limit would.
    const script = join(suitesDir, 'complete/answer_verifier/verify/check_count.py');
    const fast = await readFile(script, 'utf8');
    await writeFile(
      script,
      fast.replace('import argparse', 'import time\ntime.sleep(3)\nimport argparse'),
    );
    const v1 = await load('complete');

    // Two workers: one's start-up pass is reading the slow files when the
    // author fixes the verifier and the other worker takes the reload job.
    const startup = loader().loadAll();
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await writeFile(script, fast);
    const reload = await load('complete', loader());
    await startup;

    expect(reload).toMatchObject({ outcome: 'created', versionNumber: 2 });
    const pointer = (await source('complete')).currentSuiteId;
    expect(pointer).toBe(reload.suiteId);
    expect(pointer).not.toBe(v1.suiteId);
    // A fresh load of the same disk finds that version current.
    expect(await load('complete')).toMatchObject({ outcome: 'unchanged', versionNumber: 2 });
  }, 60_000);
});

describe('suite names', () => {
  const writeSuiteYaml = (dir: string, name: string) =>
    writeFile(join(suitesDir, dir, 'suite.yaml'), `name: ${name}\nversion_label: '1'\n`);

  it('lets two directories swap their names in one reload', async () => {
    await rm(join(suitesDir, 'mixed'), { recursive: true });
    await rm(join(suitesDir, 'no-suite-yaml'), { recursive: true });
    await cp(join(suitesDir, 'complete'), join(suitesDir, 'other'), { recursive: true });
    await writeSuiteYaml('complete', 'x');
    await writeSuiteYaml('other', 'y');
    const first = SuiteReloadResultSchema.parse(await loader().loadAll());
    expect(first.suites.map((e) => [e.sourcePath, e.outcome, e.name])).toEqual([
      ['./suites/complete', 'created', 'x'],
      ['./suites/other', 'created', 'y'],
    ]);

    await writeSuiteYaml('complete', 'y');
    await writeSuiteYaml('other', 'x');
    const swapped = SuiteReloadResultSchema.parse(await loader().loadAll());
    expect(swapped.suites.map((e) => [e.sourcePath, e.outcome, e.name])).toEqual([
      ['./suites/complete', 'created', 'y'],
      ['./suites/other', 'created', 'x'],
    ]);
    expect((await source('complete')).name).toBe('y');
    expect((await source('other')).name).toBe('x');

    // A genuine duplicate is still an error.
    await writeSuiteYaml('other', 'y');
    const duplicate = SuiteReloadResultSchema.parse(await loader().loadAll());
    expect(duplicate.suites.map((e) => [e.sourcePath, e.outcome])).toEqual([
      ['./suites/complete', 'unchanged'],
      ['./suites/other', 'error'],
    ]);
  }, 60_000);

  it('records a directory renamed during a pass as missing, so its new name loads', async () => {
    await rm(join(suitesDir, 'mixed'), { recursive: true });
    await rm(join(suitesDir, 'no-suite-yaml'), { recursive: true });
    await load('complete');
    // Pass 1 lists `complete`; then it is renamed, and a second worker's pass
    // runs to the end before pass 1 reaches the directory.
    let second: SuiteReloadEntry[] = [];
    hooks.afterList = async () => {
      await rename(join(suitesDir, 'complete'), join(suitesDir, 'renamed'));
      second = SuiteReloadResultSchema.parse(await loader().loadAll()).suites;
    };
    const first = SuiteReloadResultSchema.parse(await loader().loadAll()).suites;

    expect(second.map((e) => [e.sourcePath, e.outcome, e.name])).toEqual([
      ['./suites/complete', 'missing', 'complete'],
      ['./suites/renamed', 'created', 'complete'],
    ]);
    expect(first.map((e) => [e.sourcePath, e.outcome])).toEqual([['./suites/complete', 'missing']]);
    expect(await source('complete')).toMatchObject({ lastOutcome: 'missing' });
    expect(await source('renamed')).toMatchObject({ lastOutcome: 'created', name: 'complete' });
    // Nothing holds the name against the directory that declares it.
    expect(await load('renamed')).toMatchObject({ outcome: 'unchanged', name: 'complete' });
  }, 60_000);
});

describe('the blob store', () => {
  it('is repaired by a reload of unchanged files after it lost them', async () => {
    const v1 = await load('complete');
    // The blob volume reset without the database, then the worker restarted.
    await rm(store.blobsDir, { recursive: true });
    store = new BlobStore(join(root, 'data'));
    expect(await load('complete')).toMatchObject({ outcome: 'unchanged', suiteId: v1.suiteId });
    const files = await t.db
      .select({ sha256: taskFiles.sha256 })
      .from(taskFiles)
      .innerJoin(tasks, eq(tasks.id, taskFiles.taskId))
      .where(eq(tasks.suiteId, v1.suiteId!));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect(await store.exists(f.sha256), f.sha256).toBe(true);
  });
});

describe("the self-checks' declared time", () => {
  /** A task whose five verifiers declare 300 s each, run twice for the negative control. */
  async function slowTask(dir: string, key: string): Promise<void> {
    const task = join(dir, key);
    await mkdir(join(task, 'verify'), { recursive: true });
    await mkdir(join(task, 'expected'), { recursive: true });
    await mkdir(join(task, 'fixtures'), { recursive: true });
    const keys = [1, 2, 3, 4, 5].map((n) => `v${n}`);
    await writeFile(
      join(task, 'task.yaml'),
      [
        'summary: Check the workspace',
        'limits: { max_turns: 10, run_budget_seconds: 120, toolsets_needed: [file] }',
        'answer: { format: fenced_json, path: total }',
        'verification:',
        '  - { key: answer, type: numeric_tolerance, primary: true, params: { abs: 0.01 } }',
        ...keys.map(
          (k) =>
            `  - { key: ${k}, type: verifier_script, params: { script: ${k}.py, timeout_s: 300 } }`,
        ),
        'self_check: { expected_workspace: expected }',
        '',
      ].join('\n'),
    );
    await writeFile(join(task, 'prompt.md'), 'Add up.\n\n```json\n{ "total": 0 }\n```\n');
    await writeFile(join(task, 'reference.json'), '{ "total": 1 }');
    await writeFile(join(task, 'fixtures', 'rows.csv'), 'a\n');
    await writeFile(join(task, 'expected', 'out.csv'), 'a\n');
    // Never run: the suite is refused before any self-check starts.
    for (const k of keys) {
      await writeFile(join(task, 'verify', `${k}.py`), 'raise SystemExit("must not run")\n');
    }
  }

  it('refuses a suite whose self-checks could outlast a load-suites job, before running any', async () => {
    const dir = join(suitesDir, 'slow');
    await mkdir(dir);
    await writeFile(join(dir, 'suite.yaml'), "name: slow\nversion_label: '1'\n");
    // Each task: 5 × (300 + 10) × 2 = 3100 s; two tasks four at a time: 1550 + 2325.
    await slowTask(dir, 'first');
    await slowTask(dir, 'second');
    const entry = await load('slow');
    expect(entry).toMatchObject({ outcome: 'error', suiteId: null });
    expect(entry.message).toBe(
      "Could not reload: the self-checks may take up to 3875 s (each verifier_script's timeout_s, twice with a negative control, plus 10 s per run, 4 tasks at a time), above the 3600 s one load may take; lower timeout_s or split the suite",
    );
    expect(await source('slow')).toMatchObject({ lastOutcome: 'error', currentSuiteId: null });
    expect(await t.db.select().from(tasks)).toEqual([]);
  });

  it('loads in one reload only the suites that fit its budget, and records nothing for the rest', async () => {
    // complete and mixed each declare 90 s (one 80 s task and one 40 s task, four at a time).
    const result = SuiteReloadResultSchema.parse(await loader().loadAll({ selfCheckBudgetS: 100 }));
    expect(result.suites.map((s) => [s.sourcePath, s.outcome, s.message])).toEqual([
      ['./suites/complete', 'created', 'All 5 self-checks passed'],
      [
        './suites/mixed',
        'error',
        'Could not reload: not loaded by this reload: its self-checks may take up to 90 s, and the suites before it already declared 90 of the 100 s one reload may take; reload mixed on its own',
      ],
      ['./suites/no-suite-yaml', 'error', 'Could not reload: suite.yaml not found'],
    ]);
    const [mixed] = await t.db.select().from(suiteSources).where(eq(suiteSources.path, 'mixed'));
    expect(mixed).toBeUndefined();
    // On its own it has the whole budget.
    expect(await load('mixed')).toMatchObject({ outcome: 'created', versionNumber: 1 });
  });
});

describe('a suite with thousands of tasks', () => {
  it('inserts its task rows in chunks under the bind-parameter limit', async () => {
    const N = 4000;
    const dir = join(suitesDir, 'big');
    await mkdir(dir);
    await writeFile(join(dir, 'suite.yaml'), "name: big\nversion_label: '1'\n");
    const taskYaml = [
      'summary: Sum the amounts',
      'limits: { max_turns: 10, run_budget_seconds: 120, toolsets_needed: [file] }',
      'answer: { format: fenced_json, path: total }',
      'verification:',
      '  - { key: answer, type: numeric_tolerance, primary: true, params: { abs: 0.01 } }',
      '',
    ].join('\n');
    const prompt = 'Add up.\n\nEnd with a fenced JSON block:\n\n```json\n{ "total": 0.0 }\n```\n';
    for (let i = 0; i < N; i++) {
      const task = join(dir, `t${String(i).padStart(4, '0')}`);
      await mkdir(task);
      await writeFile(join(task, 'task.yaml'), taskYaml);
      await writeFile(join(task, 'prompt.md'), prompt);
      await writeFile(join(task, 'reference.json'), `{ "total": ${i}.5 }`);
    }
    const entry = await load('big');
    expect(entry).toMatchObject({ outcome: 'created', versionNumber: 1 });
    const [rows] = await t.db
      .select({ n: count() })
      .from(tasks)
      .where(eq(tasks.suiteId, entry.suiteId!));
    expect(rows!.n).toBe(N);
    const [suite] = await t.db.select().from(suites).where(eq(suites.id, entry.suiteId!));
    expect(suite).toMatchObject({ taskCount: N, validCount: N });
  }, 180_000);
});
