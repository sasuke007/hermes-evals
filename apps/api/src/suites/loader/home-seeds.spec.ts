/**
 * Home seeds and the expected home (Phase 6 P1, P2) on in-memory task
 * folders: what `home/` may hold, how a seed is read as Hermes reads it, and
 * the home self-checks, which run for real (python3 verifiers in scratch
 * folders) against the seeds overlaid with the expected home.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LoadIssueSchema,
  MEMORY_CHAR_LIMITS,
  SelfCheckSchema,
  type LoadIssue,
} from '@hermes-evals/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { homeFileViews } from '../views/task-views.js';
import { sha256Hex } from './hashing.js';
import { homeSeedIssues, memoryCharCount, memoryEntries } from './home-seeds.js';
import { verdict } from './read-suite.js';
import { analyseTask } from './task.js';
import type { TaskReader } from './task-files.js';
import { expectedHome, seededHome, selfCheckTask } from './task-self-check.js';
import type { SuiteEntry } from './walk.js';

type Item = string | Buffer | { link: true } | { dir: true };

/** A task folder: the walk's entries (parents included) and a reader over the same files. */
function folder(items: Record<string, Item>): { entries: SuiteEntry[]; read: TaskReader } {
  const entries = new Map<string, SuiteEntry>();
  for (const [path, item] of Object.entries(items)) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i += 1) {
      const dir = parts.slice(0, i).join('/');
      if (!entries.has(dir)) entries.set(dir, { path: dir, kind: 'dir', entered: true });
    }
    if (typeof item === 'string' || Buffer.isBuffer(item)) {
      entries.set(path, { path, kind: 'file', size: Buffer.byteLength(item) });
    } else if ('link' in item) entries.set(path, { path, kind: 'symlink' });
    else entries.set(path, { path, kind: 'dir', entered: true });
  }
  const read: TaskReader = async (path) => {
    const item = items[path];
    if (typeof item !== 'string' && !Buffer.isBuffer(item)) {
      return { ok: false, reason: 'not_regular: test' };
    }
    const content = Buffer.from(item);
    return { ok: true, content, sha256: sha256Hex(content) };
  };
  return { entries: [...entries.values()].sort((a, b) => (a.path < b.path ? -1 : 1)), read };
}

const TASK_YAML = `summary: Report in the user's usual currency
limits: { max_turns: 10, run_budget_seconds: 120, toolsets_needed: [file] }
answer: { format: fenced_json, path: total }
verification:
  - key: answer
    type: numeric_tolerance
    primary: true
    params: { abs: 0.01 }
`;
const PROMPT = 'Reply with a fenced JSON block:\n\n```json\n{ "total": 0 }\n```\n';
const USER_MD = 'Works in Lisbon.\n§\nPrefers reports in EUR.';
const MEMORY_MD = 'ACME Ltd and ACME Limited are the same vendor.';

const base = (overrides: Record<string, Item | undefined> = {}): Record<string, Item> => {
  const items: Record<string, Item | undefined> = {
    'task.yaml': TASK_YAML,
    'prompt.md': PROMPT,
    'reference.json': '{ "total": 10.5 }',
    'fixtures/amounts.csv': 'id,amount\n1,10.5\n',
    'home/memories/USER.md': USER_MD,
    'home/memories/MEMORY.md': MEMORY_MD,
    ...overrides,
  };
  return Object.fromEntries(Object.entries(items).filter(([, v]) => v !== undefined)) as Record<
    string,
    Item
  >;
};

async function analyse(items: Record<string, Item>) {
  const { entries, read } = folder(items);
  const task = await analyseTask('t', entries, read);
  for (const issue of task.issues) LoadIssueSchema.parse(issue);
  return task;
}

const brief = (issues: LoadIssue[]) => issues.map((i) => [i.severity, i.code, i.path]);

describe('home seeds', () => {
  it('stores MEMORY.md and USER.md as home_seed files, hashed like every other file', async () => {
    const task = await analyse(base());
    expect(task.issues).toEqual([]);
    expect(task.files.map((f) => [f.path, f.kind])).toEqual([
      ['fixtures/amounts.csv', 'fixture'],
      ['home/memories/MEMORY.md', 'home_seed'],
      ['home/memories/USER.md', 'home_seed'],
    ]);
    expect(task.hashedFiles.map((f) => f.path)).toContain('home/memories/USER.md');
    // An edit to a seed is a new version of the task.
    const edited = await analyse(base({ 'home/memories/USER.md': `${USER_MD}\n§\nNew entry.` }));
    expect(edited.contentHash).not.toBe(task.contentHash);
    expect(seededHome(task.files).get('memories/USER.md')?.content.toString()).toBe(USER_MD);
  });

  it('refuses any other path under home/, once per stray folder', async () => {
    const task = await analyse(
      base({
        'home/notes.md': 'x',
        'home/skills/audit/SKILL.md': 'x',
        'home/skills/audit/check.py': 'x',
        'home/memories/notes.md': 'x',
        'home/memories/USER.md': { dir: true },
        'home/memories/USER.md/inner': 'x',
      }),
    );
    expect(brief(task.issues)).toEqual([
      ['error', 'home_path_invalid', 'home/memories/USER.md'],
      ['error', 'home_path_invalid', 'home/memories/notes.md'],
      ['error', 'home_path_invalid', 'home/notes.md'],
      ['error', 'home_path_invalid', 'home/skills'],
    ]);
    expect(task.issues[0]!.message).toBe(
      "home/memories/USER.md must be a file: it seeds the trial's USER.md",
    );
    expect(task.issues[1]!.message).toBe(
      "home/memories/notes.md is not allowed: a task's home/ may hold only memories/MEMORY.md and memories/USER.md, which seed the trial's memory",
    );
    expect(task.files.filter((f) => f.path.startsWith('home/')).map((f) => f.path)).toEqual([
      'home/memories/MEMORY.md',
    ]);
    expect(task.plan).toBeNull();
  });

  it('refuses a link where a seed goes and a home that is a file', async () => {
    const linked = await analyse(base({ 'home/memories/MEMORY.md': { link: true } }));
    expect(brief(linked.issues)).toEqual([['error', 'unsafe_file', 'home/memories/MEMORY.md']]);
    const file = await analyse(
      base({ 'home/memories/USER.md': undefined, 'home/memories/MEMORY.md': undefined, home: 'x' }),
    );
    expect(brief(file.issues)).toEqual([['error', 'schema_invalid', 'home']]);
    // A file where the seeds' folder goes is refused too, not skipped: the task would
    // otherwise load valid with no seeds, and memory on and off would be the same run.
    const memFile = await analyse(
      base({
        'home/memories/USER.md': undefined,
        'home/memories/MEMORY.md': undefined,
        'home/memories': 'x',
      }),
    );
    expect(brief(memFile.issues)).toEqual([['error', 'home_path_invalid', 'home/memories']]);
    expect(memFile.plan).toBeNull();
  });

  it("warns when a seed is over Hermes's budget, as Hermes counts it", async () => {
    const entry = (n: number) => 'x'.repeat(n);
    const limit = MEMORY_CHAR_LIMITS['MEMORY.md'];
    // Two entries joined by the three-character delimiter, exactly at the limit, then one over.
    const at = `${entry(1000)}\n§\n${entry(limit - 1003)}`;
    expect(memoryCharCount(memoryEntries(at))).toBe(limit);
    expect(homeSeedIssues({ path: 'home/memories/MEMORY.md', content: Buffer.from(at) })).toEqual(
      [],
    );
    const task = await analyse(base({ 'home/memories/MEMORY.md': `${at}y` }));
    expect(brief(task.issues)).toEqual([
      ['warning', 'home_seed_format', 'home/memories/MEMORY.md'],
    ]);
    expect(task.issues[0]!.message).toMatch(
      /^home\/memories\/MEMORY.md is 2201 characters as Hermes counts them .* over the 2200 Hermes allows/,
    );
    // A warning: the task stays loadable.
    expect(task.plan).not.toBeNull();

    // USER.md has its own, smaller budget; one long entry reads as text without delimiters.
    const user = homeSeedIssues({
      path: 'home/memories/USER.md',
      content: Buffer.from(entry(MEMORY_CHAR_LIMITS['USER.md'] + 1)),
    });
    expect(user[0]!.message).toMatch(
      /over the 1375 Hermes allows.*reads as text written without § delimiters$/,
    );
  });

  it('counts characters, not bytes, and ignores what Hermes strips', () => {
    const text = '﻿  Prefers €.  \r\n§\r\n\n§\nPrefers €.\n§\n Lisbon ';
    expect(memoryEntries(text)).toEqual(['Prefers €.', 'Lisbon']);
    expect(memoryCharCount(memoryEntries(text))).toBe('Prefers €.'.length + 3 + 'Lisbon'.length);
  });

  it('warns when a seed is not a §-delimited list', () => {
    const issues = (text: string) =>
      homeSeedIssues({ path: 'home/memories/USER.md', content: Buffer.from(text) }).map(
        (i) => `${i.severity}:${i.code}: ${i.message}`,
      );
    expect(issues('Works in Lisbon. § Prefers EUR.')).toEqual([
      'warning:home_seed_format: home/memories/USER.md: entry 1 has a § that is not on a line of its own, so Hermes reads it as part of the entry; entries are separated by a line holding only §',
    ]);
    expect(issues('- Works in Lisbon\n- Prefers EUR\n')).toEqual([
      'warning:home_seed_format: home/memories/USER.md looks like a list of 2 items, but has no § delimiter, so Hermes reads it as one entry; put each item on its own, separated by a line holding only §',
    ]);
    expect(issues(' \n§\n ')).toEqual([
      'warning:home_seed_format: home/memories/USER.md holds no entries, so it seeds nothing; entries are separated by a line holding only §',
    ]);
    // One entry with no delimiter is a list of one: nothing to say.
    expect(issues('Prefers reports in EUR.')).toEqual([]);
    expect(issues(USER_MD)).toEqual([]);
  });

  it('refuses a seed that is not UTF-8: Hermes would read it as empty', () => {
    expect(
      homeSeedIssues({ path: 'home/memories/USER.md', content: Buffer.from([0xff, 0xfe, 0x41]) }),
    ).toEqual([
      {
        severity: 'error',
        code: 'schema_invalid',
        path: 'home/memories/USER.md',
        message:
          'home/memories/USER.md is not valid UTF-8 text; Hermes would read it as an empty memory file',
      },
    ]);
  });
});

const HOME_CHECK_YAML = `${TASK_YAML}  - key: memory
    type: file_check
    params: { root: home, path: memories/USER.md, contains: [USD] }
  - key: saved
    type: verifier_script
    params: { script: remembers.py }
self_check: { expected_home: golden_home }
`;
const REMEMBERS_PY = `import argparse, json, os
parser = argparse.ArgumentParser()
parser.add_argument("--answer", required=True)
parser.add_argument("--workspace", required=True)
parser.add_argument("--home", required=True)
args = parser.parse_args()
path = os.path.join(args.home, "memories", "USER.md")
text = open(path).read() if os.path.exists(path) else ""
print(json.dumps({"score": 1 if "USD" in text else 0, "comment": f"{len(text)} characters"}))
`;
const EXPECTED_USER_MD = `${USER_MD}\n§\nThis quarter's reports are in USD.`;

describe('the expected home', () => {
  const homeTask = (overrides: Record<string, Item | undefined> = {}) =>
    base({
      'task.yaml': HOME_CHECK_YAML,
      'verify/remembers.py': REMEMBERS_PY,
      'golden_home/memories/USER.md': EXPECTED_USER_MD,
      ...overrides,
    });

  it('stores its files as expected_home, overlaid on the seeds, and plans a negative control', async () => {
    const task = await analyse(homeTask());
    expect(task.issues).toEqual([]);
    expect(task.files.find((f) => f.path === 'golden_home/memories/USER.md')?.kind).toBe(
      'expected_home',
    );
    expect(task.plan).toMatchObject({
      expectedDir: null,
      expectedHomeDir: 'golden_home',
      negativeControl: true,
    });
    const tree = expectedHome(task.files, 'golden_home');
    expect([...tree.keys()].sort()).toEqual(['memories/MEMORY.md', 'memories/USER.md']);
    expect(tree.get('memories/USER.md')?.content.toString()).toBe(EXPECTED_USER_MD);
    expect(tree.get('memories/MEMORY.md')?.kind).toBe('home_seed');
  });

  it('may be nested, and Task detail places its files where the self-check does', async () => {
    const yaml = HOME_CHECK_YAML.replace('golden_home', './known_good/home/');
    const task = await analyse(
      homeTask({
        'task.yaml': yaml,
        'golden_home/memories/USER.md': undefined,
        'known_good/home/memories/USER.md': EXPECTED_USER_MD,
      }),
    );
    expect(task.issues).toEqual([]);
    expect(task.plan?.expectedHomeDir).toBe('known_good/home');
    const rows = task.files.map((f) => ({ ...f, taskId: 't' }));
    const views = homeFileViews({ taskYaml: yaml }, rows, new Map());
    const tree = expectedHome(task.files, 'known_good/home');
    const expectedView = views.find((v) => v.kind === 'expected_home')!;
    expect(expectedView).toMatchObject({
      path: 'known_good/home/memories/USER.md',
      homePath: 'memories/USER.md',
    });
    expect(tree.get(expectedView.homePath)?.path).toBe(expectedView.path);
    expect(views.filter((v) => v.kind === 'home_seed').map((v) => v.homePath)).toEqual(
      [...seededHome(task.files).keys()].sort(),
    );
  });

  it('holds only files under memories/, as the trial home collects', async () => {
    const task = await analyse(homeTask({ 'golden_home/config.yaml': 'x' }));
    expect(brief(task.issues)).toEqual([['error', 'home_path_invalid', 'golden_home/config.yaml']]);
  });

  it('must be a folder of its own', async () => {
    const at = (dir: string) =>
      analyse(homeTask({ 'task.yaml': HOME_CHECK_YAML.replace('golden_home', dir) }));
    expect(brief((await at('fixtures/home')).issues)).toContainEqual([
      'error',
      'schema_invalid',
      'task.yaml#self_check.expected_home',
    ]);
    // The schema refuses home/ itself, and the loader does not say it again; with no
    // usable expected home, the home file_check has nothing to be proven on.
    expect(brief((await at('home')).issues)).toEqual([
      ['error', 'schema_invalid', 'task.yaml#self_check.expected_home'],
      ['error', 'self_check_unsupported', 'task.yaml#verification[1]'],
    ]);
    expect(brief((await at('missing')).issues)).toEqual([
      ['error', 'file_missing', 'task.yaml#self_check.expected_home'],
    ]);
  });

  it('is what a file_check with root: home needs', async () => {
    const task = await analyse(
      homeTask({
        'task.yaml': HOME_CHECK_YAML.replace('self_check: { expected_home: golden_home }\n', ''),
      }),
    );
    expect(task.issues).toEqual([
      expect.objectContaining({
        severity: 'error',
        code: 'self_check_unsupported',
        key: 'memory',
        message:
          'memory: file_check with root: home needs self_check.expected_home in task.yaml, the known-good home it is proven on before any agent runs',
      }),
    ]);
  });

  it('may not hold a rubric, nor may home/', async () => {
    const judge = (rubric: string) =>
      `${HOME_CHECK_YAML.replace('self_check:', `  - key: judge\n    type: llm_judge\n    params: { rubric: ${rubric} }\nself_check:`)}`;
    const inExpected = await analyse(
      homeTask({
        'task.yaml': judge('golden_home/memories/rubric.md'),
        'golden_home/memories/rubric.md': 'r',
      }),
    );
    expect(inExpected.issues.find((i) => i.key === 'judge')?.message).toBe(
      'judge: the rubric must not be under golden_home/, the expected home (self_check.expected_home), whose files are the known-good home; put it beside task.yaml',
    );
  });

  describe('self-checks', () => {
    let root: string;
    beforeAll(async () => {
      root = await mkdtemp(join(tmpdir(), 'home-self-check-'));
    });
    afterAll(() => rm(root, { recursive: true, force: true }));
    const deps = () => ({
      scratch: async (prefix: string) => {
        const path = await mkdtemp(join(root, `${prefix}-`));
        return { path, dispose: () => rm(path, { recursive: true, force: true }) };
      },
    });

    it('pass on the expected home and fail on the seeds alone', async () => {
      const task = await analyse(homeTask());
      const selfCheck = SelfCheckSchema.parse(await selfCheckTask(task, deps()));
      expect(selfCheck.results.map((r) => [r.key, r.mode, r.expect ?? null, r.status])).toEqual([
        ['answer', 'answer', null, 'passed'],
        ['memory', 'home', 'pass', 'passed'],
        ['memory', 'home', 'fail', 'failed'],
        ['saved', 'home', 'pass', 'passed'],
        ['saved', 'home', 'fail', 'failed'],
      ]);
      expect(selfCheck.status).toBe('passed');
      expect(selfCheck.expected_home).toEqual([
        { path: 'memories/USER.md', sha256: sha256Hex(Buffer.from(EXPECTED_USER_MD)) },
      ]);
      expect(selfCheck.expected_workspace).toBeUndefined();
      expect(verdict(task, selfCheck)).toEqual({ valid: true, invalidReason: null });
    });

    it('make the task invalid when the seed alone already passes', async () => {
      const task = await analyse(homeTask({ 'home/memories/USER.md': EXPECTED_USER_MD }));
      const selfCheck = await selfCheckTask(task, deps());
      expect(selfCheck.status).toBe('failed');
      expect(verdict(task, selfCheck)).toEqual({
        valid: false,
        invalidReason:
          'memory: the check passes on the home seeds alone, so it would pass any agent',
      });
    });
  });
});
