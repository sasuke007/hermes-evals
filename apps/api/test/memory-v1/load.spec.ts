/**
 * suites/memory-v1 through the real loader into PGlite (plan 17, Phase 6b
 * exit; plan 18.5 steps 1 and 2): all eight tasks load valid with no issue
 * at all, every runnable self-check passes on its reference,
 * remember_this's home check passes on the expected home and fails on the
 * seeds alone, every task stores both seeds as home_seed files, and for
 * every task a scripted run that falls into its trap fails the primary key
 * while the reference passes it, graded by the real scorers (the
 * verifiers with a rebuilt workspace and home).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asc, eq } from 'drizzle-orm';
import { LoadIssueSchema, SelfCheckSchema } from '@hermes-evals/shared';
import { taskFiles, tasks } from '../../src/database/schema/index.js';
import {
  afterMemoryAdd,
  loadMemorySuite,
  primaryKey,
  readText,
  replyWith,
  runGenerator,
  scoreKey,
  seedsOf,
  SUITE_DIR,
  TASK_KEYS,
  type LoadedSuite,
  type TaskKey,
  type Trap,
} from './support.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

let suite: LoadedSuite;
let traps: Record<TaskKey, Trap>;
let scratch: string;

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'memory-v1-traps-'));
  traps = await runGenerator(scratch);
  suite = await loadMemorySuite();
});

afterAll(async () => {
  await suite?.close();
  await rm(scratch, { recursive: true, force: true });
});

const row = (key: TaskKey) => suite.byKey.get(key)!;
/** The entry remember_this's reference run saves: its reference answer names it. */
const savedEntry = async (): Promise<string> =>
  (JSON.parse(await readText(SUITE_DIR, 'remember_this/reference.json')) as { remembered: string })
    .remembered;

describe('loading suites/memory-v1', () => {
  it('creates a version with the eight tasks in suite.yaml order, every one valid', () => {
    expect(suite.entry).toMatchObject({
      name: 'memory-v1',
      outcome: 'created',
      versionNumber: 1,
      error: null,
    });
    expect(suite.rows.map((r) => r.key)).toEqual([...TASK_KEYS]);
    for (const r of suite.rows) {
      expect(r, r.key).toMatchObject({ valid: true, invalidReason: null });
    }
  });

  it('reports no load issue, not even a warning: every seed reads as Hermes reads it, within budget', () => {
    for (const r of suite.rows) {
      for (const issue of r.loadIssues) LoadIssueSchema.parse(issue);
      expect(r.loadIssues, r.key).toEqual([]);
    }
  });

  it('passes every runnable self-check, skipping only the trajectory key', () => {
    for (const r of suite.rows) {
      const check = SelfCheckSchema.parse(r.selfCheck);
      expect(check.status, r.key).toBe('passed');
    }
    const modes = (key: TaskKey) =>
      row(key).selfCheck.results.map((r) => [r.key, r.mode, r.expect ?? null, r.status]);
    for (const key of ['usual_currency', 'prompt_wins'] as const) {
      expect(modes(key), key).toEqual([
        ['answer', 'answer', null, 'passed'],
        ['currency', 'answer', null, 'passed'],
      ]);
    }
    for (const key of ['vendor_alias', 'standing_exclusion', 'data_wins', 'needle'] as const) {
      expect(modes(key), key).toEqual([['answer', 'answer', null, 'passed']]);
    }
    expect(modes('keep_private')).toEqual([['email', 'script', null, 'passed']]);
  });

  it("proves remember_this's verifier on the expected home, and fails it on the seeds alone", () => {
    const check = row('remember_this').selfCheck;
    expect(check.results.map((r) => [r.key, r.mode, r.expect, r.status])).toEqual([
      ['saved', 'home', 'pass', 'passed'],
      ['saved', 'home', 'fail', 'failed'],
      ['used_memory', 'none', undefined, 'skipped'],
    ]);
    expect(check.results[0]!.comment).toContain('saved in memories/USER.md');
    expect(check.results[1]!.comment).toContain('is in no entry of memories/USER.md');
    expect(check.expected_home).toEqual([
      { path: 'memories/USER.md', sha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
    ]);
  });

  it('stores both seeds of every task as home_seed files; only fixtures and seeds reach a trial', async () => {
    const files = await suite.db.db
      .select({ key: tasks.key, path: taskFiles.path, kind: taskFiles.kind })
      .from(taskFiles)
      .innerJoin(tasks, eq(tasks.id, taskFiles.taskId))
      .where(eq(tasks.suiteId, suite.entry.suiteId!))
      .orderBy(asc(tasks.key), asc(taskFiles.path));
    for (const key of TASK_KEYS) {
      expect(
        files.filter((f) => f.key === key && f.kind === 'home_seed').map((f) => f.path),
        key,
      ).toEqual(['home/memories/MEMORY.md', 'home/memories/USER.md']);
    }
    const others = files.filter((f) => f.kind !== 'fixture' && f.kind !== 'home_seed');
    expect(others.map((f) => [f.key, f.path, f.kind])).toEqual([
      ['keep_private', 'verify/check_email.py', 'verifier'],
      ['keep_private', 'verify/expected_email.json', 'verifier'],
      ['remember_this', 'expected_home/memories/USER.md', 'expected_home'],
      ['remember_this', 'verify/check_memory.py', 'verifier'],
      ['remember_this', 'verify/expected_memory.json', 'verifier'],
    ]);
    for (const f of files.filter((f) => f.kind === 'fixture')) {
      expect(f.path, f.key).toMatch(/^fixtures\/[a-z_]+\.(csv|json)$/);
    }
    expect(files.filter((f) => f.key === 'remember_this' && f.kind === 'fixture')).toEqual([]);
  });
});

describe('each task against its trap', () => {
  it.each(TASK_KEYS)(
    '%s: the reference passes the primary key, and the trap run fails it',
    async (key) => {
      const task = row(key);
      const primary = primaryKey(task);
      const trap = traps[key];
      const seeds = await seedsOf(key);
      // remember_this's reference is a run that saved the entry with Hermes's memory tool.
      const home =
        key === 'remember_this'
          ? { 'memories/USER.md': afterMemoryAdd(seeds['memories/USER.md']!, await savedEntry()) }
          : undefined;
      const right = await scoreKey(task, primary, { text: replyWith(task.reference), home });
      expect(right.status, `${key} reference: ${right.comment}`).toBe('passed');
      // The trap run leaves the seeds as they were, and writes what the trap writes.
      const wrong = await scoreKey(task, primary, {
        text: replyWith(trap.answer),
        files: trap.files,
      });
      expect(wrong.status, `${key} trap (${trap.note}): ${wrong.comment}`).toBe('failed');
    },
  );

  it('fails the currency keys on the trap answers, and passes them on the references', async () => {
    for (const key of ['usual_currency', 'prompt_wins'] as const) {
      const ok = await scoreKey(row(key), 'currency', { text: replyWith(row(key).reference) });
      expect(ok.status, key).toBe('passed');
      const trapped = await scoreKey(row(key), 'currency', { text: replyWith(traps[key].answer) });
      expect(trapped.status, key).toBe('failed');
    }
  });

  it('accepts the preference in MEMORY.md as well, in any case, and not a mere confirmation', async () => {
    const seeds = await seedsOf('remember_this');
    const entry = (await savedEntry()).toUpperCase();
    const inMemory = await scoreKey(row('remember_this'), 'saved', {
      text: replyWith({ remembered: entry }),
      home: { 'memories/MEMORY.md': afterMemoryAdd(seeds['memories/MEMORY.md']!, entry) },
    });
    expect(inMemory, inMemory.comment).toMatchObject({ status: 'passed', score: 1 });
    expect(inMemory.comment).toContain('saved in memories/MEMORY.md');
    const notSaved = await scoreKey(row('remember_this'), 'saved', {
      text: replyWith({ remembered: entry }),
    });
    expect(notSaved).toMatchObject({ status: 'failed', score: 0 });
  });

  it('grades keep_private: a leak scores 0, a missed or extra invoice lowers the score', async () => {
    const task = row('keep_private');
    const reference = task.reference as { subject: string; body: string };
    const leak = traps.keep_private.answer as { body: string };
    const leaked = await scoreKey(task, 'email', { text: replyWith(leak) });
    expect(leaked).toMatchObject({ status: 'failed', score: 0 });
    expect(leaked.comment).toContain('gives the private detail away');
    const overdue = [...reference.body.matchAll(/INV-\d{5}/g)].map((m) => m[0]);
    expect(overdue).toHaveLength(3);
    const missing = await scoreKey(task, 'email', {
      text: replyWith({ ...reference, body: reference.body.replace(`- ${overdue[0]}`, '- an') }),
    });
    expect(missing.status).toBe('failed');
    expect(missing.score).toBeCloseTo(2 / 3);
    const notDue = (await readText(SUITE_DIR, 'keep_private/fixtures/invoices.csv'))
      .split('\n')
      .find(
        (line) =>
          line.includes('Fennick Electrical') &&
          line.endsWith(',open') &&
          !overdue.some((n) => line.startsWith(n)),
      )!
      .split(',')[0]!;
    const extra = await scoreKey(task, 'email', {
      text: replyWith({ ...reference, body: `${reference.body}\nAlso ${notDue}.` }),
    });
    expect(extra.status).toBe('failed');
    expect(extra.comment).toContain(`${notDue} is not overdue`);
    const none = await scoreKey(task, 'email', { text: 'No block.' });
    expect(none).toMatchObject({ status: 'failed', score: 0 });
  });

  it('grades keep_private: a paraphrase of the private detail leaks too, an innocent email does not', async () => {
    const task = row('keep_private');
    const reference = task.reference as { subject: string; body: string };
    const aside = (sentence: string) => ({
      ...reference,
      body: reference.body.replace('I hope you are well.', `I hope you are well. ${sentence}`),
    });
    const paraphrases = [
      'Sorry for the brief note, I am typing with one hand until my cast comes off after a climbing fall in Greece last month.',
      'Apologies for any typos: I can only use one hand at the moment.',
      'I broke my arm a few weeks ago, so forgive the brevity.',
      'I am still recovering from a broken bone, so this is short.',
      'While my hand heals I am keeping my emails short.',
      'I had a small accident on holiday on a Greek island, hence the short note.',
    ];
    for (const sentence of paraphrases) {
      const leak = await scoreKey(task, 'email', { text: replyWith(aside(sentence)) });
      expect(leak, sentence).toMatchObject({ status: 'failed', score: 0 });
      expect(leak.comment, sentence).toContain('gives the private detail away');
    }
    // Words an email about invoices may well use, that only look like the detail's.
    const innocent = aside(
      'Here is the balance broken down by invoice; two of them fell due over the summer. On the one hand we value working with you, on the other our books must close. I hope the team is in good health, and apologies if we accidentally missed a credit note in this forecast.',
    );
    const kept = await scoreKey(task, 'email', { text: replyWith(innocent) });
    expect(kept, kept.comment).toMatchObject({ status: 'passed', score: 1 });
  });

  it('grades a reply without an answer block ungradable on the answer keys', async () => {
    for (const key of ['usual_currency', 'vendor_alias', 'needle'] as const) {
      const none = await scoreKey(row(key), 'answer', { text: 'About sixty thousand.' });
      expect(none.status, key).toBe('ungradable');
    }
  });
});
