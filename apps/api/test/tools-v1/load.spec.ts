/**
 * suites/tools-v1 through the real loader into PGlite (plan 17, Phase 6b
 * exit; plan 18.5 steps 1 and 2): all six tasks load valid with no issue at
 * all, every runnable self-check passes on its reference, reshape_json's
 * negative controls fail on the bare fixtures, and for every task a
 * scripted reply that falls into its trap fails the primary key while the
 * reference passes it, graded by the real scorers.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { LoadIssueSchema, SelfCheckSchema } from '@hermes-evals/shared';
import { taskFiles, tasks } from '../../src/database/schema/index.js';
import {
  loadToolsSuite,
  primaryKey,
  readText,
  replyWith,
  runGenerator,
  scoreKey,
  SUITE_DIR,
  TASK_KEYS,
  type LoadedSuite,
  type TaskKey,
  type Trap,
} from './support.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const STOCK_FILE = 'stock_by_sku.json';

let suite: LoadedSuite;
let traps: Record<TaskKey, Trap>;
let scratch: string;

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'tools-v1-traps-'));
  traps = await runGenerator(scratch);
  suite = await loadToolsSuite();
});

afterAll(async () => {
  await suite?.close();
  await rm(scratch, { recursive: true, force: true });
});

const row = (key: TaskKey) => suite.byKey.get(key)!;
const expectedStock = () => readText(SUITE_DIR, 'reshape_json/expected', STOCK_FILE);

describe('loading suites/tools-v1', () => {
  it('creates a version with the six tasks in suite.yaml order, every one valid', () => {
    expect(suite.entry).toMatchObject({
      name: 'tools-v1',
      outcome: 'created',
      versionNumber: 1,
      error: null,
    });
    expect(suite.rows.map((r) => r.key)).toEqual([...TASK_KEYS]);
    for (const r of suite.rows) {
      expect(r, r.key).toMatchObject({ valid: true, invalidReason: null });
    }
  });

  it('reports no load issue, not even a warning', () => {
    for (const r of suite.rows) {
      for (const issue of r.loadIssues) LoadIssueSchema.parse(issue);
      expect(r.loadIssues, r.key).toEqual([]);
    }
  });

  it('passes every self-check on the reference', () => {
    for (const r of suite.rows) {
      const check = SelfCheckSchema.parse(r.selfCheck);
      expect(check.status, r.key).toBe('passed');
      for (const result of check.results) {
        expect(result.mode, `${r.key}.${result.key}`).not.toBe('none');
        if (result.expect !== 'fail') {
          expect(result.status, `${r.key}.${result.key}: ${result.comment}`).toBe('passed');
        }
      }
    }
    const modes = (key: TaskKey) =>
      row(key).selfCheck.results.map((r) => [r.key, r.mode, r.expect ?? null, r.status]);
    for (const key of TASK_KEYS.filter((k) => k !== 'reshape_json')) {
      expect(modes(key), key).toEqual([['answer', 'answer', null, 'passed']]);
    }
  });

  it("proves reshape_json's checks on its expected workspace, and fails both on the bare fixtures", () => {
    const results = row('reshape_json').selfCheck.results;
    expect(results.map((r) => [r.key, r.mode, r.expect, r.status])).toEqual([
      ['stock_file', 'workspace', 'pass', 'passed'],
      ['stock_file', 'workspace', 'fail', 'failed'],
      ['quantities', 'workspace', 'pass', 'passed'],
      ['quantities', 'workspace', 'fail', 'failed'],
    ]);
    expect(results[1]!.comment).toBe(`negative control: ${STOCK_FILE} does not exist`);
    expect(results[3]!.comment).toContain(`${STOCK_FILE} not found in the workspace`);
    expect(row('reshape_json').selfCheck.expected_workspace).toEqual([
      { path: STOCK_FILE, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
    ]);
  });

  it('stores every file under its kind: only fixtures ever reach a trial', async () => {
    const files = await suite.db.db
      .select({ key: tasks.key, path: taskFiles.path, kind: taskFiles.kind })
      .from(taskFiles)
      .innerJoin(tasks, eq(tasks.id, taskFiles.taskId))
      .where(eq(tasks.suiteId, suite.entry.suiteId!))
      .orderBy(asc(tasks.key), asc(taskFiles.path));
    expect(files.filter((f) => f.kind !== 'fixture').map((f) => [f.key, f.path, f.kind])).toEqual([
      ['reshape_json', `expected/${STOCK_FILE}`, 'expected'],
      ['reshape_json', 'verify/check_stock.py', 'verifier'],
      ['reshape_json', 'verify/expected_stock.json', 'verifier'],
    ]);
    expect(files.filter((f) => f.kind === 'fixture').map((f) => [f.key, f.path])).toEqual([
      ['big_csv', 'fixtures/transactions.csv'],
      ['checksum', 'fixtures/SHA256SUMS'],
      ['checksum', 'fixtures/export.csv'],
      ['extract_ibans', 'fixtures/payouts.log'],
      ['join_three', 'fixtures/customers.csv'],
      ['join_three', 'fixtures/orders.csv'],
      ['join_three', 'fixtures/prices.csv'],
      ['reshape_json', 'fixtures/inventory.json'],
      ['small_lookup', 'fixtures/catalog.csv'],
    ]);
  });
});

describe('each task against its trap', () => {
  it.each(TASK_KEYS)(
    '%s: the reference passes the primary key, and the trap answer fails it',
    async (key) => {
      const task = row(key);
      const primary = primaryKey(task);
      const trap = traps[key];
      const right = await scoreKey(task, primary, {
        text: replyWith(task.reference),
        // A file-producing task's reference is the expected workspace.
        ...(key === 'reshape_json' ? { files: { [STOCK_FILE]: await expectedStock() } } : {}),
      });
      expect(right.status, `${key} reference: ${right.comment}`).toBe('passed');
      const wrong = await scoreKey(task, primary, {
        text: replyWith(trap.answer),
        files: trap.files,
      });
      expect(wrong.status, `${key} trap (${trap.note}): ${wrong.comment}`).toBe('failed');
    },
  );

  it("fails reshape_json's verifier on the trap too: SKUs missing, and others counted in part", async () => {
    const result = await scoreKey(row('reshape_json'), 'quantities', {
      text: replyWith(traps.reshape_json.answer),
      files: traps.reshape_json.files,
    });
    expect(result.status).toBe('failed');
    // The 20 SKUs only DUB holds are missing; shared SKUs with bins past the page are short.
    expect(result.score).toBeLessThan(100 / 120);
    expect(result.comment).toMatch(/^\d+ of 120 SKU entries right: SKU-\d{5}: /);
  });

  it("fails reshape_json's primary on a wrong quantity, not only its verifier", async () => {
    const expected = JSON.parse(await expectedStock()) as Record<
      string,
      { total: number; warehouses: Record<string, number> }
    >;
    const both = async (content: string) => {
      const run = { text: replyWith({}), files: { [STOCK_FILE]: content } };
      return {
        file: await scoreKey(row('reshape_json'), 'stock_file', run),
        values: await scoreKey(row('reshape_json'), 'quantities', run),
      };
    };
    // One SKU short of its quantity, as an overwrite instead of a sum leaves it: the shape still holds.
    const [sku, entry] = Object.entries(expected).find(
      ([, e]) => Object.keys(e.warehouses).length === 1 && e.total > 1,
    )!;
    const [warehouse] = Object.keys(entry.warehouses);
    const one = await both(
      JSON.stringify({
        ...expected,
        [sku]: { total: entry.total - 1, warehouses: { [warehouse!]: entry.total - 1 } },
      }),
    );
    expect(one.file.status).toBe('failed');
    expect(one.file.comment).toContain(`file/${sku} must be equal to constant`);
    expect(one.values).toMatchObject({ status: 'failed' });
    expect(one.values.comment).toContain(`119 of 120 SKU entries right: ${sku}:`);

    // The whole export read, but each warehouse's first bin taken instead of the sum of its bins.
    const Inventory = z.object({
      warehouses: z.array(
        z.object({
          code: z.string(),
          bins: z.array(
            z.object({ items: z.array(z.object({ sku: z.string(), qty: z.number() })) }),
          ),
        }),
      ),
    });
    const inventory = Inventory.parse(
      JSON.parse(await readText(SUITE_DIR, 'reshape_json/fixtures/inventory.json')),
    );
    const unsummed: Record<string, { total: number; warehouses: Record<string, number> }> = {};
    for (const w of inventory.warehouses) {
      for (const item of w.bins.flatMap((b) => b.items)) {
        const e = (unsummed[item.sku] ??= { total: 0, warehouses: {} });
        if (w.code in e.warehouses) continue;
        e.warehouses[w.code] = item.qty;
        e.total += item.qty;
      }
    }
    expect(Object.keys(unsummed).sort()).toEqual(Object.keys(expected));
    const first = await both(JSON.stringify(unsummed));
    expect(first.file.status, first.file.comment).toBe('failed');
    expect(first.file.comment).toContain('must be equal to constant');
    expect(first.values.status).toBe('failed');
    expect(first.values.score).toBeLessThan(0.5);

    // Quantities written as strings fail the schema too.
    const strings = Object.fromEntries(
      Object.entries(expected).map(([s, e]) => [s, { ...e, total: String(e.total) }]),
    );
    const shape = await both(JSON.stringify(strings));
    expect(shape.file.status).toBe('failed');
    expect(shape.file.comment).toContain('does not match the JSON schema');
    // An entry for a SKU the export does not hold is refused as well.
    const extra = await both(
      JSON.stringify({ ...expected, 'SKU-99999': { total: 1, warehouses: { AMS: 1 } } }),
    );
    expect(extra.file.status).toBe('failed');
    expect(extra.file.comment).toContain('must NOT have additional properties');
    // The expected file itself, its entries in another order, passes both.
    const reordered = Object.fromEntries(Object.entries(expected).reverse());
    const right = await both(JSON.stringify(reordered, null, 1));
    expect([right.file.status, right.values.status]).toEqual(['passed', 'passed']);
  });

  it("fails checksum's honest file-only answer, null, and accepts the digest in capitals", async () => {
    const task = row('checksum');
    const honest = await scoreKey(task, 'answer', { text: replyWith({ sha256: null }) });
    expect(honest.status).toBe('failed');
    const reference = task.reference as { sha256: string };
    const upper = await scoreKey(task, 'answer', {
      text: replyWith({ sha256: reference.sha256.toUpperCase() }),
    });
    expect(upper.status).toBe('passed');
  });

  it('grades a reply without an answer block ungradable, and a missing stock file as failed', async () => {
    const none = await scoreKey(row('big_csv'), 'answer', { text: 'About twenty million.' });
    expect(none.status).toBe('ungradable');
    const file = await scoreKey(row('reshape_json'), 'stock_file', { text: replyWith({}) });
    expect(file).toMatchObject({ status: 'failed', comment: `${STOCK_FILE} does not exist` });
    const values = await scoreKey(row('reshape_json'), 'quantities', { text: 'No block.' });
    expect(values).toMatchObject({ status: 'failed', score: 0 });
  });
});
