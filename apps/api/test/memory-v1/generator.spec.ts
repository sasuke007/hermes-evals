/**
 * The memory-v1 generator (scripts/fixtures/memory-v1.ts) run with plain
 * Node, as plan 18.2 P6 and Phase 6b R2 ask: it reproduces the same bytes on
 * every run; `--check` passes on the repository (so nobody edited a
 * reference, a seed or a fixture by hand, and nobody forgot to re-run it)
 * and fails on a changed or a stale file; and every trap changes the answer
 * of its task, or what its run leaves behind.
 */
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  generator,
  listFiles,
  MOCK_SCRIPTS,
  REPO,
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
  first = await mkdtemp(join(tmpdir(), 'memory-v1-gen-a-'));
  second = await mkdtemp(join(tmpdir(), 'memory-v1-gen-b-'));
  traps = await runGenerator(first);
  await runGenerator(second);
});

afterAll(async () => {
  await rm(first, { recursive: true, force: true });
  await rm(second, { recursive: true, force: true });
});

describe('scripts/fixtures/memory-v1.ts', () => {
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

  it('writes the fixtures, seeds, prompts, references and verifier data of all eight tasks, and the mock scripts', async () => {
    const generated = await listFiles(join(first, 'suites/memory-v1'));
    for (const key of TASK_KEYS) {
      for (const file of [
        'reference.json',
        'prompt.md',
        'home/memories/USER.md',
        'home/memories/MEMORY.md',
      ]) {
        expect(generated, key).toContain(`${key}/${file}`);
      }
    }
    expect(
      generated.filter((f) => !/\/(fixtures|home)\/|\/(prompt\.md|reference\.json)$/.test(f)),
    ).toEqual([
      'keep_private/verify/expected_email.json',
      'remember_this/expected_home/memories/USER.md',
      'remember_this/verify/expected_memory.json',
    ]);
    // remember_this has no fixtures: it is answered from the prompt and saved to memory.
    expect(generated.filter((f) => f.startsWith('remember_this/fixtures/'))).toEqual([]);
    expect(await listFiles(join(first, 'scripts'))).toEqual([
      'phase6b-memory-v1-mock-scripts.json',
    ]);
  });

  it('is what the repository holds: --check passes, and every generated file is byte-identical', async () => {
    const check = generator(['--check']);
    expect(check.status, check.stderr).toBe(0);
    for (const file of await listFiles(join(first, 'suites/memory-v1'))) {
      const inRepo = await readFile(join(SUITE_DIR, file));
      expect(inRepo.equals(await readFile(join(first, 'suites/memory-v1', file))), file).toBe(true);
    }
    expect(
      (await readFile(join(REPO, MOCK_SCRIPTS))).equals(await readFile(join(first, MOCK_SCRIPTS))),
    ).toBe(true);
  });

  it('--check fails on a changed file and on a stale one in a folder the generator owns', async () => {
    const copy = await mkdtemp(join(tmpdir(), 'memory-v1-gen-check-'));
    try {
      await cp(first, copy, { recursive: true });
      expect(generator(['--check', '--out', copy]).status).toBe(0);
      const seed = join(copy, 'suites/memory-v1/needle/home/memories/MEMORY.md');
      await writeFile(seed, `${await readFile(seed, 'utf8')}§\nAn edit by hand.\n`);
      const changed = generator(['--check', '--out', copy]);
      expect(changed.status).toBe(1);
      expect(changed.stderr).toContain('needle/home/memories/MEMORY.md differs');
      await cp(join(first, 'suites/memory-v1/needle'), join(copy, 'suites/memory-v1/needle'), {
        recursive: true,
      });
      await writeFile(join(copy, 'suites/memory-v1/vendor_alias/fixtures/old.csv'), 'a\n');
      const stale = generator(['--check', '--out', copy]);
      expect(stale.status).toBe(1);
      expect(stale.stderr).toContain(
        'vendor_alias/fixtures/old.csv is not a file the generator writes',
      );
    } finally {
      await rm(copy, { recursive: true, force: true });
    }
  });

  it('gives every task a trap that differs from its reference, in the reference’s shape', async () => {
    expect(Object.keys(traps).sort()).toEqual([...TASK_KEYS].sort());
    for (const key of TASK_KEYS) {
      const reference: unknown = JSON.parse(
        await readFile(join(SUITE_DIR, key, 'reference.json'), 'utf8'),
      );
      expect(Object.keys(traps[key].answer).sort(), key).toEqual(
        Object.keys(reference as object).sort(),
      );
      if (key === 'remember_this') {
        // The trap confirms in the same words; what differs is where it saved them.
        expect(traps[key].answer).toEqual(reference);
        expect(Object.keys(traps[key].files ?? {})).toEqual(['preferences.md']);
      } else {
        expect(traps[key].answer, key).not.toEqual(reference);
      }
    }
    expect(TASK_KEYS.filter((k) => traps[k].off_passes)).toEqual([
      'prompt_wins',
      'data_wins',
      'keep_private',
    ]);
  });
});
