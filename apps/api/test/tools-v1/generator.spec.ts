/**
 * The tools-v1 generator (scripts/fixtures/tools-v1.ts) run with plain Node,
 * as Phase 6b R2 asks: it reproduces the same bytes on every run, its
 * --check passes on the repository and fails on a drifted or stale file,
 * the suite and the mock scripts in the repository are exactly what it
 * writes, the fixtures have the sizes plan 18.3 names, and every trap
 * changes the answer of its task.
 */
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import {
  generator,
  listFiles,
  MOCK_SCRIPTS,
  readText,
  REPO,
  runGenerator,
  SUITE_DIR,
  TASK_KEYS,
  type Trap,
  type TaskKey,
} from './support.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const SUITE_PATH = 'suites/tools-v1';

let first: string;
let second: string;
let traps: Record<TaskKey, Trap>;

beforeAll(async () => {
  first = await mkdtemp(join(tmpdir(), 'tools-v1-gen-a-'));
  second = await mkdtemp(join(tmpdir(), 'tools-v1-gen-b-'));
  traps = await runGenerator(first);
  await runGenerator(second);
});

afterAll(async () => {
  await rm(first, { recursive: true, force: true });
  await rm(second, { recursive: true, force: true });
});

/** The lines of a text file, without the newline that ends the last one. */
const linesOf = (text: string) => text.replace(/\n$/, '').split('\n');

describe('scripts/fixtures/tools-v1.ts', () => {
  it('writes the same bytes on every run', async () => {
    const files = await listFiles(first);
    expect(files).toEqual(await listFiles(second));
    for (const file of files) {
      expect(
        (await readFile(join(second, file))).equals(await readFile(join(first, file))),
        file,
      ).toBe(true);
    }
  });

  it('writes every prompt, fixture and reference, the expected workspace, and the mock scripts', async () => {
    const generated = await listFiles(join(first, SUITE_PATH));
    for (const key of TASK_KEYS) {
      expect(generated, key).toContain(`${key}/prompt.md`);
      expect(generated, key).toContain(`${key}/reference.json`);
      expect(
        generated.some((f) => f.startsWith(`${key}/fixtures/`)),
        key,
      ).toBe(true);
    }
    expect(generated.filter((f) => !/\/(fixtures\/|prompt\.md|reference\.json)/.test(f))).toEqual([
      'reshape_json/expected/stock_by_sku.json',
      'reshape_json/task.yaml',
      'reshape_json/verify/expected_stock.json',
    ]);
    expect(await listFiles(join(first, 'scripts'))).toEqual([MOCK_SCRIPTS.replace('scripts/', '')]);
  });

  it('is what the repository holds: no generated file differs, and no stale fixture is left', async () => {
    const generated = await listFiles(join(first, SUITE_PATH));
    for (const file of generated) {
      const inRepo = await readFile(join(SUITE_DIR, file));
      expect(inRepo.equals(await readFile(join(first, SUITE_PATH, file))), file).toBe(true);
    }
    expect(
      (await readFile(join(REPO, MOCK_SCRIPTS))).equals(await readFile(join(first, MOCK_SCRIPTS))),
    ).toBe(true);
    const owned = (await listFiles(SUITE_DIR)).filter((f) =>
      /^[^/]+\/(fixtures|expected)\//.test(f),
    );
    expect(owned.filter((f) => !generated.includes(f))).toEqual([]);
  });

  it('passes --check on the repository', () => {
    const run = generator(['--check']);
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
  });

  it('fails --check on a changed file, a missing one and a stale fixture, naming each', async () => {
    const copy = await mkdtemp(join(tmpdir(), 'tools-v1-gen-check-'));
    try {
      expect(generator(['--out', copy]).status).toBe(0);
      expect(generator(['--out', copy, '--check']).status).toBe(0);
      await appendFile(
        join(copy, SUITE_PATH, 'big_csv/fixtures/transactions.csv'),
        'T20001,A-1000,1.00,settled\n',
      );
      await rm(join(copy, SUITE_PATH, 'checksum/reference.json'));
      await mkdir(join(copy, SUITE_PATH, 'join_three/fixtures/old'), { recursive: true });
      await writeFile(join(copy, SUITE_PATH, 'join_three/fixtures/old/orders.csv'), 'x\n');
      const run = generator(['--out', copy, '--check']);
      expect(run.status).toBe(1);
      expect(run.stderr.trim().split('\n').sort()).toEqual([
        `tools-v1: ${SUITE_PATH}/big_csv/fixtures/transactions.csv differs from what the generator writes`,
        `tools-v1: ${SUITE_PATH}/checksum/reference.json differs from what the generator writes`,
        `tools-v1: ${SUITE_PATH}/join_three/fixtures/old/orders.csv is not written by the generator`,
      ]);
    } finally {
      await rm(copy, { recursive: true, force: true });
    }
  });

  it('gives every task a trap answer that differs from its reference, in the same shape', async () => {
    expect(Object.keys(traps).sort()).toEqual([...TASK_KEYS].sort());
    for (const key of TASK_KEYS) {
      const reference: unknown = JSON.parse(await readText(SUITE_DIR, key, 'reference.json'));
      expect(traps[key].answer, key).not.toEqual(reference);
      expect(Object.keys(traps[key].answer).sort(), key).toEqual(
        Object.keys(reference as object).sort(),
      );
    }
    expect(Object.keys(traps.reshape_json.files ?? {})).toEqual(['stock_by_sku.json']);
  });
});

describe('the fixtures', () => {
  it('have the sizes plan 18.3 names: 20,000 rows and 300 log lines', async () => {
    const csv = linesOf(await readText(SUITE_DIR, 'big_csv/fixtures/transactions.csv'));
    expect(csv[0]).toBe('id,account,amount,status');
    expect(csv).toHaveLength(20_001);
    expect(linesOf(await readText(SUITE_DIR, 'extract_ibans/fixtures/payouts.log'))).toHaveLength(
      300,
    );
  });

  it('put part of each large file past what one read_file call shows (2,000 lines)', async () => {
    const page = (lines: string[]) =>
      lines
        .slice(0, 2000)
        .reduce((n, line, i) => n + `${i + 1}|${line}`.length + (i > 0 ? 1 : 0), 0);
    const csv = linesOf(await readText(SUITE_DIR, 'big_csv/fixtures/transactions.csv'));
    // The whole first page is within read_file's 100,000-character budget: the cut is the line cap.
    expect(page(csv)).toBeLessThanOrEqual(100_000);
    const inventory = linesOf(await readText(SUITE_DIR, 'reshape_json/fixtures/inventory.json'));
    expect(inventory.length).toBeGreaterThan(2000);
    expect(page(inventory)).toBeLessThanOrEqual(100_000);
    // DUB's last bins, where the SKUs only DUB holds sit, start past line 2,000.
    expect(inventory.findIndex((l) => l.includes('"bin": "DUB-17"')) + 1).toBeGreaterThan(2000);
  });

  it('lists only invented-but-valid IBANs in the reference, and only invalid ones besides in the trap', async () => {
    const valid = (iban: string) => {
      const lengths: Record<string, number> = {
        AT: 20,
        BE: 16,
        DE: 22,
        ES: 24,
        FR: 27,
        GB: 22,
        IT: 27,
        NL: 18,
        PL: 28,
        SE: 24,
      };
      const digits = `${iban.slice(4)}${iban.slice(0, 4)}`.replace(/[A-Z]/g, (c) =>
        String(c.charCodeAt(0) - 55),
      );
      return lengths[iban.slice(0, 2)] === iban.length && BigInt(digits) % 97n === 1n;
    };
    const reference = z
      .object({ ibans: z.array(z.string()) })
      .parse(JSON.parse(await readText(SUITE_DIR, 'extract_ibans/reference.json'))).ibans;
    expect(reference).toHaveLength(24);
    expect(reference.every(valid)).toBe(true);
    const trapped = z.array(z.string()).parse(traps.extract_ibans.answer.ibans);
    const extra = trapped.filter((i) => !reference.includes(i));
    expect(extra).toHaveLength(6);
    expect(extra.some(valid)).toBe(false);
    const log = await readText(SUITE_DIR, 'extract_ibans/fixtures/payouts.log');
    for (const iban of [...reference, ...extra]) {
      const print = iban.match(/.{1,4}/g)!.join(' ');
      expect(log.includes(iban) || log.includes(`"${print}"`), iban).toBe(true);
    }
  });

  it("holds every expected entry in reshape_json's file_check schema, and refuses any other key", async () => {
    const TaskSchema = z.object({
      verification: z.array(
        z.object({ key: z.string(), params: z.record(z.string(), z.unknown()) }),
      ),
    });
    const task = TaskSchema.parse(parseYaml(await readText(SUITE_DIR, 'reshape_json/task.yaml')));
    const Entry = z.strictObject({
      total: z.number().int(),
      warehouses: z.record(z.string(), z.number().int()),
    });
    const schema = z
      .strictObject({
        type: z.literal('object'),
        required: z.array(z.string()),
        additionalProperties: z.literal(false),
        properties: z.record(z.string(), z.strictObject({ const: Entry })),
      })
      .parse(task.verification.find((v) => v.key === 'stock_file')!.params.json_schema);
    const expected = z
      .record(z.string(), Entry)
      .parse(JSON.parse(await readText(SUITE_DIR, 'reshape_json/expected/stock_by_sku.json')));
    // Every value is pinned, not only the shape: a wrong quantity fails the primary key.
    expect(schema.required).toEqual(Object.keys(expected));
    expect(schema.required).toHaveLength(120);
    expect(
      Object.fromEntries(Object.entries(schema.properties).map(([sku, p]) => [sku, p.const])),
    ).toEqual(expected);
    expect(await readText(SUITE_DIR, 'reshape_json/verify/expected_stock.json')).toBe(
      await readText(SUITE_DIR, 'reshape_json/expected/stock_by_sku.json'),
    );
  });
});
