/**
 * The knowledge-v1 generator (scripts/fixtures/knowledge-v1.ts) run with
 * plain Node, as plan 18.2 P6 and Phase 6b R2 ask: it reproduces the same
 * bytes on every run, `--check` passes on the repository and fails on a
 * changed or stale file, the suite, the code table, the documents and the
 * mock scripts in the repository are exactly what it writes, and every trap
 * changes the answer of its task.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DOCUMENTS,
  listFiles,
  MOCK_SCRIPTS,
  REPO,
  runGenerator,
  runGeneratorArgs,
  SUITE_DIR,
  TASK_FILES,
  TASK_KEYS,
  type TaskKey,
  type Trap,
} from './support.js';

vi.setConfig({ testTimeout: 60_000 });

let first: string;
let second: string;
let traps: Record<TaskKey, Trap>;

beforeAll(async () => {
  first = await mkdtemp(join(tmpdir(), 'knowledge-v1-gen-a-'));
  second = await mkdtemp(join(tmpdir(), 'knowledge-v1-gen-b-'));
  traps = await runGenerator(first);
  await runGenerator(second);
});

afterAll(async () => {
  await rm(first, { recursive: true, force: true });
  await rm(second, { recursive: true, force: true });
});

/** What the generator writes, relative to the repository root (traps.json is the test's own). */
const generated = async (root: string) => (await listFiles(root)).filter((f) => f !== 'traps.json');

describe('scripts/fixtures/knowledge-v1.ts', () => {
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

  it('writes each task’s fixture, prompt and reference, the code table, the documents and the mock scripts', async () => {
    expect(await generated(first)).toEqual(
      [
        ...TASK_KEYS.flatMap((k) => [
          `suites/knowledge-v1/${k}/fixtures/${TASK_FILES[k].file}`,
          `suites/knowledge-v1/${k}/prompt.md`,
          `suites/knowledge-v1/${k}/reference.json`,
        ]),
        'samples/skills/bx7-format/codes.md',
        ...DOCUMENTS.map((d) => `samples/documents/knowledge-v1/${d.doc}`),
        MOCK_SCRIPTS,
      ].sort(),
    );
  });

  it('is what the repository holds, byte for byte', async () => {
    for (const file of await generated(first)) {
      const inRepo = await readFile(join(REPO, file));
      expect(inRepo.equals(await readFile(join(first, file))), file).toBe(true);
    }
    // fixtures/ is the generator's alone: every file in it is one it writes.
    const owned = (await listFiles(SUITE_DIR)).filter((f) => /^[^/]+\/fixtures\//.test(f));
    expect(owned.sort()).toEqual(
      TASK_KEYS.map((k) => `${k}/fixtures/${TASK_FILES[k].file}`).sort(),
    );
  });

  it('passes --check on the repository, and fails it on a changed or a stale file', async () => {
    expect(runGeneratorArgs(['--check'])).toMatchObject({ status: 0, stderr: '' });
    const scratch = await mkdtemp(join(tmpdir(), 'knowledge-v1-check-'));
    try {
      await runGenerator(scratch);
      expect(runGeneratorArgs(['--check', '--out', scratch]).status).toBe(0);
      const reference = join(scratch, 'suites/knowledge-v1/closing_balance/reference.json');
      await writeFile(reference, '{ "closing_balance": 0 }\n');
      await writeFile(join(scratch, 'samples/documents/knowledge-v1/notes.md'), 'stale\n');
      const failed = runGeneratorArgs(['--check', '--out', scratch]);
      expect(failed.status).toBe(1);
      expect(failed.stderr).toContain('suites/knowledge-v1/closing_balance/reference.json differs');
      expect(failed.stderr).toContain('samples/documents/knowledge-v1/notes.md is not generated');
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it('gives every task a trap answer that differs from its reference, in the reference’s shape', async () => {
    expect(Object.keys(traps).sort()).toEqual([...TASK_KEYS].sort());
    for (const key of TASK_KEYS) {
      const reference: unknown = JSON.parse(
        await readFile(join(SUITE_DIR, key, 'reference.json'), 'utf8'),
      );
      expect(traps[key].answer, key).not.toEqual(reference);
      expect(Object.keys(traps[key].answer).sort(), key).toEqual(
        Object.keys(reference as object).sort(),
      );
      expect(traps[key].file, key).toBe(TASK_FILES[key].file);
      const prompt = await readFile(join(SUITE_DIR, key, 'prompt.md'), 'utf8');
      expect(prompt, key).toContain(traps[key].phrase);
    }
  });

  it('builds large_file from exactly 5,000 records', async () => {
    const lines = (
      await readFile(join(SUITE_DIR, 'large_file/fixtures/statement_2026_q2.bx7'), 'utf8')
    )
      .replace(/\n$/, '')
      .split('\n');
    expect(lines.every((l) => l.length === 64)).toBe(true);
    // A record's first line has part 0; continuation lines are part of the record above.
    expect(lines.filter((l) => l[1] === '0')).toHaveLength(5000);
    expect(lines.length).toBeGreaterThan(5000);
  });
});
