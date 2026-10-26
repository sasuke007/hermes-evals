/**
 * The invoices-v1 generator (scripts/fixtures/invoices-v1.ts) run with plain
 * Node, as plan 18.2 P6 asks: it reproduces the same bytes on every run, the
 * suite and the mock scripts in the repository are exactly what it writes
 * (so nobody edited a reference by hand, and nobody forgot to re-run it),
 * and every trap changes the answer of its task.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  listFiles,
  MOCK_SCRIPTS,
  REPO,
  runGenerator,
  SUITE_DIR,
  TASK_KEYS,
  type Trap,
  type TaskKey,
} from './support.js';

vi.setConfig({ testTimeout: 60_000 });

let first: string;
let second: string;
let traps: Record<TaskKey, Trap>;

beforeAll(async () => {
  first = await mkdtemp(join(tmpdir(), 'invoices-v1-gen-a-'));
  second = await mkdtemp(join(tmpdir(), 'invoices-v1-gen-b-'));
  traps = await runGenerator(first);
  await runGenerator(second);
});

afterAll(async () => {
  await rm(first, { recursive: true, force: true });
  await rm(second, { recursive: true, force: true });
});

describe('scripts/fixtures/invoices-v1.ts', () => {
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

  it('writes the fixtures, references and expected files of all twelve tasks, and the mock scripts', async () => {
    const generated = await listFiles(join(first, 'suites/invoices-v1'));
    for (const key of TASK_KEYS) {
      expect(generated, key).toContain(`${key}/reference.json`);
      expect(generated, key).toContain(`${key}/fixtures/invoices.csv`);
    }
    // Only the prompts that state a day the fixtures are built around are generated.
    expect(generated.filter((f) => f.endsWith('prompt.md'))).toEqual([
      'late_fees/prompt.md',
      'overdue_list/prompt.md',
    ]);
    expect(generated.filter((f) => f.includes('/verify/') || f.includes('/expected/'))).toEqual([
      'late_fees/verify/expected_fees.json',
      'summary_file/expected/summary.csv',
      'summary_file/verify/expected_summary.json',
    ]);
    expect(await listFiles(join(first, 'scripts'))).toEqual(['phase6-mock-scripts.json']);
  });

  it('is what the repository holds: no generated file differs, and no stale fixture is left', async () => {
    const generated = await listFiles(join(first, 'suites/invoices-v1'));
    for (const file of generated) {
      const inRepo = await readFile(join(SUITE_DIR, file));
      expect(inRepo.equals(await readFile(join(first, 'suites/invoices-v1', file))), file).toBe(
        true,
      );
    }
    expect(
      (await readFile(join(REPO, MOCK_SCRIPTS))).equals(await readFile(join(first, MOCK_SCRIPTS))),
    ).toBe(true);
    // fixtures/ and expected/ are the generator's alone: every file in them is one it writes.
    const owned = (await listFiles(SUITE_DIR)).filter((f) =>
      /^[^/]+\/(fixtures|expected)\//.test(f),
    );
    expect(owned.filter((f) => !generated.includes(f))).toEqual([]);
  });

  it('gives every task a trap answer that differs from its reference', async () => {
    expect(Object.keys(traps).sort()).toEqual([...TASK_KEYS].sort());
    for (const key of TASK_KEYS) {
      const reference: unknown = JSON.parse(
        await readFile(join(SUITE_DIR, key, 'reference.json'), 'utf8'),
      );
      expect(traps[key].answer, key).not.toEqual(reference);
      // The trap answer has the reference's shape: the same top-level keys.
      expect(Object.keys(traps[key].answer).sort(), key).toEqual(
        Object.keys(reference as object).sort(),
      );
    }
    expect(traps.summary_file.files?.['summary.csv']).toMatch(
      /^vendor,unpaid_invoices,outstanding\n/,
    );
  });
});
