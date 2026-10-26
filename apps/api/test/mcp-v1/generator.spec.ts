/**
 * The mcp-v1 generator (scripts/fixtures/mcp-v1.ts) run with plain Node, as
 * Phase 6b R2 asks: it reproduces the same bytes on every run; the suite,
 * the documents and the mock scripts in the repository are exactly what it
 * writes, and its --check says so (and says when they are not); the
 * documents are the very data the two sample servers serve (R4); and every
 * trap changes the answer of its task.
 */
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listFiles, REPO } from '../invoices-v1/support.js';
import {
  DIRECTORY_FILE,
  DOCUMENTS_DIR,
  GENERATOR,
  LEDGER_FILE,
  MOCK_SCRIPTS,
  runGenerator,
  SUITE_DIR,
  TASK_KEYS,
  type TaskKey,
  type Trap,
} from './support.js';

vi.setConfig({ testTimeout: 60_000 });

let first: string;
let second: string;
let traps: Record<TaskKey, Trap>;

beforeAll(async () => {
  first = await mkdtemp(join(tmpdir(), 'mcp-v1-gen-a-'));
  second = await mkdtemp(join(tmpdir(), 'mcp-v1-gen-b-'));
  traps = await runGenerator(first);
  await runGenerator(second);
});

afterAll(async () => {
  await rm(first, { recursive: true, force: true });
  await rm(second, { recursive: true, force: true });
});

const generatorCheck = (root?: string) =>
  spawnSync(process.execPath, [GENERATOR, '--check', ...(root ? ['--out', root] : [])], {
    encoding: 'utf8',
  });

/** Every file the generator writes, relative to the repository root. */
const GENERATED = [
  'samples/documents/mcp-v1/invoices.csv',
  'samples/documents/mcp-v1/vendors.json',
  MOCK_SCRIPTS,
  ...TASK_KEYS.flatMap((k) => [
    `suites/mcp-v1/${k}/prompt.md`,
    `suites/mcp-v1/${k}/reference.json`,
  ]),
].sort();

describe('scripts/fixtures/mcp-v1.ts', () => {
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

  it('writes every prompt and reference, the two documents and the mock scripts, and nothing else', async () => {
    expect((await listFiles(first)).filter((f) => f !== 'traps.json')).toEqual(GENERATED);
  });

  it('is what the repository holds, and --check says so', async () => {
    for (const file of GENERATED) {
      expect(
        (await readFile(join(REPO, file))).equals(await readFile(join(first, file))),
        file,
      ).toBe(true);
    }
    const run = generatorCheck();
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
  });

  it('leaves nothing stale: the suite holds only generated and hand-written files', async () => {
    const handWritten = ['suite.yaml', ...TASK_KEYS.map((k) => `${k}/task.yaml`)];
    const generated = GENERATED.filter((f) => f.startsWith('suites/mcp-v1/')).map((f) =>
      f.slice('suites/mcp-v1/'.length),
    );
    expect(await listFiles(SUITE_DIR)).toEqual([...handWritten, ...generated].sort());
    expect(await listFiles(DOCUMENTS_DIR)).toEqual(['invoices.csv', 'vendors.json']);
  });

  it('fails --check, naming the file, when a generated file differs', async () => {
    const copy = await mkdtemp(join(tmpdir(), 'mcp-v1-gen-c-'));
    try {
      await cp(first, copy, { recursive: true });
      const reference = join(copy, 'suites/mcp-v1/all_pages/reference.json');
      await writeFile(reference, '{ "total_eur": 1 }\n');
      const run = generatorCheck(copy);
      expect(run.status).toBe(1);
      expect(run.stderr).toContain('suites/mcp-v1/all_pages/reference.json differs');
      expect(generatorCheck(first).status).toBe(0);
    } finally {
      await rm(copy, { recursive: true, force: true });
    }
  });

  it("attaches as documents exactly the bytes the two servers serve (docs-export's data)", async () => {
    expect(
      (await readFile(join(DOCUMENTS_DIR, 'invoices.csv'))).equals(await readFile(LEDGER_FILE)),
    ).toBe(true);
    expect(
      (await readFile(join(DOCUMENTS_DIR, 'vendors.json'))).equals(await readFile(DIRECTORY_FILE)),
    ).toBe(true);
  });

  it('gives every task a trap answer that differs from its reference, in the same shape', async () => {
    expect(Object.keys(traps).sort()).toEqual([...TASK_KEYS].sort());
    for (const key of TASK_KEYS) {
      const reference: unknown = JSON.parse(
        await readFile(join(SUITE_DIR, key, 'reference.json'), 'utf8'),
      );
      expect(traps[key].answer, key).not.toEqual(reference);
      expect(Object.keys(traps[key].answer).sort(), key).toEqual(
        Object.keys(reference as object).sort(),
      );
    }
  });

  it('states in every prompt that the data is in tools or files, and tags it with its own phrase', async () => {
    for (const key of TASK_KEYS) {
      const prompt = await readFile(join(SUITE_DIR, key, 'prompt.md'), 'utf8');
      expect(prompt.startsWith(`Ticket ${traps[key].tag}.\n`), key).toBe(true);
      expect(prompt, key).toContain(
        'either as tools, the `invoice-db` and `vendor-directory` MCP servers, or as files under `docs/`',
      );
      expect(prompt, key).toMatch(/fenced JSON block, exactly in this shape:\n\n```json\n/);
    }
  });
});
