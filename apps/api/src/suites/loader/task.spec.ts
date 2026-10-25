/**
 * Issue detection on in-memory task folders: every rule of plan 4.2 and the
 * file rules, without touching disk.
 */
import { LoadIssueSchema, type LoadIssue } from '@hermes-evals/shared';
import {
  KEY_SETUP_SECONDS,
  MAX_SCORING_SECONDS,
  scoringSeconds,
} from '../../scoring/scoring-time.js';
import { sha256Hex } from './hashing.js';
import { MAX_SUITE_FILE_BYTES } from './limits.js';
import { analyseTask } from './task.js';
import type { TaskReader } from './task-files.js';
import type { SuiteEntry } from './walk.js';

type Item = string | { link: true } | { fifo: true } | { bytes: number };

/** A task folder: the walk's entries (parents included) and a reader over the same files. */
function folder(items: Record<string, Item>): { entries: SuiteEntry[]; read: TaskReader } {
  const entries = new Map<string, SuiteEntry>();
  for (const [path, item] of Object.entries(items)) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i += 1) {
      const dir = parts.slice(0, i).join('/');
      if (!entries.has(dir)) entries.set(dir, { path: dir, kind: 'dir', entered: true });
    }
    if (typeof item === 'string')
      entries.set(path, { path, kind: 'file', size: Buffer.byteLength(item) });
    else if ('link' in item) entries.set(path, { path, kind: 'symlink' });
    else if ('fifo' in item) entries.set(path, { path, kind: 'special', type: 'fifo' });
    else entries.set(path, { path, kind: 'file', size: item.bytes });
  }
  const read: TaskReader = async (path) => {
    const item = items[path];
    if (typeof item !== 'string') return { ok: false, reason: 'not_regular: test' };
    const content = Buffer.from(item);
    return { ok: true, content, sha256: sha256Hex(content) };
  };
  return { entries: [...entries.values()].sort((a, b) => (a.path < b.path ? -1 : 1)), read };
}

const TASK_YAML = `summary: Sum the amounts
limits: { max_turns: 10, run_budget_seconds: 120, toolsets_needed: [file] }
answer: { format: fenced_json, path: total }
verification:
  - key: answer
    type: numeric_tolerance
    primary: true
    params: { abs: 0.01 }
`;
const PROMPT = 'Reply with a fenced JSON block:\n\n```json\n{ "total": 0 }\n```\n';

const base = (overrides: Record<string, Item | undefined> = {}): Record<string, Item> => {
  const items: Record<string, Item | undefined> = {
    'task.yaml': TASK_YAML,
    'prompt.md': PROMPT,
    'reference.json': '{ "total": 10.5 }',
    'fixtures/amounts.csv': 'id,amount\n1,10.5\n',
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

const withVerification = (yaml: string) =>
  TASK_YAML.replace(/verification:[\s\S]*$/, `verification:\n${yaml}`);

const codes = (issues: LoadIssue[]) => issues.map((i) => `${i.severity}:${i.code}`);

describe('a well-formed task', () => {
  it('has no issues, a plan, and answer.path on its primary', async () => {
    const task = await analyse(base());
    expect(task.issues).toEqual([]);
    expect(task.summary).toBe('Sum the amounts');
    expect(task.reference).toEqual({ total: 10.5 });
    expect(task.verification).toEqual([
      {
        key: 'answer',
        type: 'numeric_tolerance',
        primary: true,
        params: { abs: 0.01, path: 'total' },
      },
    ]);
    expect(task.plan).toMatchObject({ expectedDir: null, negativeControl: false });
    expect(task.files.map((f) => [f.path, f.kind])).toEqual([['fixtures/amounts.csv', 'fixture']]);
    expect(task.hashedFiles.map((f) => f.path).sort()).toEqual([
      'fixtures/amounts.csv',
      'prompt.md',
      'reference.json',
      'task.yaml',
    ]);
  });

  it('keeps its content hash when a file nothing reads changes, not when a fixture does', async () => {
    const plain = await analyse(base());
    expect((await analyse(base({ 'README.md': 'notes' }))).contentHash).toBe(plain.contentHash);
    expect(
      (await analyse(base({ 'fixtures/amounts.csv': 'id,amount\n1,11\n' }))).contentHash,
    ).not.toBe(plain.contentHash);
  });

  it('only warns when the prompt does not ask for a fenced JSON block', async () => {
    const task = await analyse(base({ 'prompt.md': 'What is the total?' }));
    expect(codes(task.issues)).toEqual(['warning:prompt_no_fenced_json']);
    expect(task.plan).not.toBeNull();
  });

  it('does not give answer.path to a file_check primary', async () => {
    const yaml = TASK_YAML.replace(
      /verification:[\s\S]*$/,
      `verification:
  - key: out
    type: file_check
    primary: true
    params: { path: out.csv }
self_check: { expected_workspace: expected }
`,
    );
    const task = await analyse(base({ 'task.yaml': yaml, 'expected/out.csv': 'a\n' }));
    expect(task.issues).toEqual([]);
    expect(task.verification[0]!.params).toEqual({ path: 'out.csv' });
    expect(task.plan).toMatchObject({ expectedDir: 'expected', negativeControl: true });
    expect(task.files.map((f) => [f.path, f.kind])).toContainEqual([
      'expected/out.csv',
      'expected',
    ]);
  });
});

describe('task.yaml rules', () => {
  it('reports a syntax error with its line and column', async () => {
    const task = await analyse(base({ 'task.yaml': 'summary: x\nlimits: a: b\n' }));
    expect(task.issues).toEqual([
      {
        severity: 'error',
        code: 'yaml_invalid',
        path: 'task.yaml',
        message: 'task.yaml: line 2, column 9: Nested mappings are not allowed in compact mappings',
      },
    ]);
    expect(task.plan).toBeNull();
    expect(task.taskYaml).toBe('summary: x\nlimits: a: b\n');
    // The loader fails the directory with this, keeping the last good version.
    expect(task.yamlError).toMatchObject({
      file: 'task.yaml',
      line: 2,
      column: 9,
      message: 'Nested mappings are not allowed in compact mappings',
    });
    expect(task.yamlError!.excerpt.find((l) => l.highlight)?.text).toBe('limits: a: b');
  });

  it('reports task.yaml that is not UTF-8 as a yaml error without a position', async () => {
    const task = await analyseTask(
      'bad',
      [{ path: 'task.yaml', kind: 'file', size: 2 }],
      async () => ({ ok: true, content: Buffer.from([0xff, 0xfe]), sha256: 'a'.repeat(64) }),
    );
    expect(task.yamlError).toEqual({
      file: 'task.yaml',
      line: null,
      column: null,
      message: 'task.yaml is not valid UTF-8 text',
      excerpt: [],
    });
    expect(task.issues[0]).toMatchObject({ code: 'yaml_invalid', path: 'task.yaml' });
  });

  it('has no yaml error for a task.yaml that parses, even with schema problems', async () => {
    const task = await analyse(base({ 'task.yaml': 'summary: x\n' }));
    expect(task.yamlError).toBeNull();
    expect(task.issues.some((i) => i.code === 'schema_invalid')).toBe(true);
  });

  it('reports a missing task.yaml, prompt and reference', async () => {
    const task = await analyse({ 'fixtures/a.csv': 'x\n' });
    expect(task.issues.map((i) => [i.code, i.path])).toEqual([
      ['file_missing', 'task.yaml'],
      ['file_missing', 'prompt.md'],
      ['reference_invalid', 'reference.json'],
    ]);
    expect(task.files).toHaveLength(1);
  });

  it('maps an unknown type to unknown_type on its entry', async () => {
    const yaml = withVerification(`  - key: answer
    type: fuzzy_match
    primary: true
`);
    const task = await analyse(base({ 'task.yaml': yaml }));
    expect(task.issues).toEqual([
      expect.objectContaining({
        code: 'unknown_type',
        key: 'answer',
        path: 'task.yaml#verification[0].type',
        message: expect.stringMatching(
          /^unknown scorer type "fuzzy_match"; known types: numeric_tolerance, .* \(line 6\)$/,
        ),
      }),
    ]);
    expect(task.verification).toEqual([]);
  });

  it('needs exactly one primary', async () => {
    const none = await analyse(
      base({
        'task.yaml': withVerification(`  - key: a
    type: exact_match
`),
      }),
    );
    expect(none.issues).toEqual([
      expect.objectContaining({ code: 'primary_count', path: 'task.yaml#verification' }),
    ]);
    const two = await analyse(
      base({
        'task.yaml': withVerification(`  - { key: a, type: exact_match, primary: true }
  - { key: b, type: exact_match, primary: true }
`),
      }),
    );
    expect(two.issues).toEqual([
      expect.objectContaining({
        code: 'primary_count',
        message: expect.stringMatching(/^2 verification entries have primary: true \(a, b\)/),
      }),
    ]);
  });

  it('reports a repeated key where it is repeated', async () => {
    const task = await analyse(
      base({
        'task.yaml': withVerification(`  - { key: a, type: exact_match, primary: true }
  - { key: a, type: json_match }
`),
      }),
    );
    expect(task.issues).toEqual([
      expect.objectContaining({
        code: 'duplicate_key',
        key: 'a',
        path: 'task.yaml#verification[1].key',
      }),
    ]);
  });

  it('checks params against the strict schema of their type, with the YAML path', async () => {
    const task = await analyse(
      base({
        'task.yaml': withVerification(`  - key: answer
    type: numeric_tolerance
    primary: true
    params: { tolerance: 0.01 }
  - key: trace
    type: trajectory_match
    params: { tool: read_file, min_calls: 3, max_calls: 1 }
`),
      }),
    );
    expect(task.issues.map((i) => [i.code, i.key, i.path])).toEqual([
      ['params_invalid', 'answer', 'task.yaml#verification[0].params.tolerance'],
      ['params_invalid', 'trace', 'task.yaml#verification[1].params.max_calls'],
    ]);
    // Entries are kept, as declared, for the page to show.
    expect(task.verification.map((v) => v.key)).toEqual(['answer', 'trace']);
    expect(task.plan).toBeNull();
  });

  it('refuses checks that could outlast one scoring pass', async () => {
    const verifiers = (count: number) =>
      Array.from(
        { length: count },
        (_, i) => `  - key: v${i}
    type: verifier_script
    params: { script: check.py, timeout_s: 300 }
`,
      ).join('');
    const answer = `  - key: answer
    type: numeric_tolerance
    primary: true
    params: { abs: 0.01 }
`;
    const files = { 'verify/check.py': 'print(\'{"passed": true}\')\n' };
    // 11 x (300 + 10) + 10 = 3420 s fits; one more is 3730 s, above MAX_SCORING_SECONDS.
    expect(scoringSeconds([{ type: 'numeric_tolerance', params: {} }])).toBe(KEY_SETUP_SECONDS);
    const fits = await analyse(
      base({ 'task.yaml': withVerification(answer + verifiers(11)), ...files }),
    );
    expect(codes(fits.issues)).toEqual([]);
    const tooSlow = await analyse(
      base({ 'task.yaml': withVerification(answer + verifiers(12)), ...files }),
    );
    expect(tooSlow.issues).toEqual([
      expect.objectContaining({
        severity: 'error',
        code: 'schema_invalid',
        path: 'task.yaml#verification',
        message: expect.stringMatching(
          new RegExp(
            `^the checks may take up to 3730 s to score .* above the ${MAX_SCORING_SECONDS} s`,
          ),
        ),
      }),
    ]);
    expect(tooSlow.plan).toBeNull();
  });

  it('reports shape errors with the line they are on', async () => {
    const yaml = TASK_YAML.replace('max_turns: 10', 'max_turns: 900').replace(
      'summary:',
      'sumary:',
    );
    const task = await analyse(base({ 'task.yaml': yaml }));
    expect(task.issues).toContainEqual(
      expect.objectContaining({ code: 'schema_invalid', path: 'task.yaml#limits.max_turns' }),
    );
    expect(task.issues).toContainEqual(
      expect.objectContaining({
        code: 'schema_invalid',
        path: 'task.yaml#sumary',
        message: expect.stringMatching(/\(line 1\)$/),
      }),
    );
  });
});

describe('file rules', () => {
  it('needs the verifier script under verify/ and the rubric in the folder', async () => {
    const yaml = withVerification(`  - { key: answer, type: numeric_tolerance, primary: true }
  - { key: check, type: verifier_script, params: { script: check.py } }
  - { key: judge, type: llm_judge, params: { rubric: rubric.md } }
`);
    const missing = await analyse(base({ 'task.yaml': yaml }));
    expect(missing.issues.map((i) => [i.code, i.key, i.path])).toEqual([
      ['file_missing', 'check', 'task.yaml#verification[1].params.script'],
      ['file_missing', 'judge', 'task.yaml#verification[2].params.rubric'],
    ]);
    const present = await analyse(
      base({ 'task.yaml': yaml, 'verify/check.py': 'print(1)', 'rubric.md': 'be fair' }),
    );
    expect(present.issues).toEqual([]);
    expect(present.files.map((f) => [f.path, f.kind])).toEqual([
      ['fixtures/amounts.csv', 'fixture'],
      ['rubric.md', 'rubric'],
      ['verify/check.py', 'verifier'],
    ]);
  });

  it('refuses a rubric the agent could read', async () => {
    const yaml = withVerification(`  - { key: answer, type: numeric_tolerance, primary: true }
  - { key: judge, type: llm_judge, params: { rubric: fixtures/rubric.md } }
`);
    const task = await analyse(base({ 'task.yaml': yaml, 'fixtures/rubric.md': 'secret' }));
    expect(task.issues).toEqual([
      expect.objectContaining({ code: 'schema_invalid', key: 'judge' }),
    ]);
  });

  it('refuses a rubric under the expected workspace, which would be stored as expected', async () => {
    const yaml = withVerification(`  - { key: answer, type: numeric_tolerance, primary: true }
  - { key: judge, type: llm_judge, params: { rubric: golden/rubric.md } }
self_check: { expected_workspace: golden }
`);
    const task = await analyse(
      base({ 'task.yaml': yaml, 'golden/rubric.md': 'be fair', 'golden/out.csv': 'a\n' }),
    );
    expect(task.issues).toEqual([
      {
        severity: 'error',
        code: 'schema_invalid',
        key: 'judge',
        path: 'task.yaml#verification[1].params.rubric',
        message:
          'judge: the rubric must not be under golden/, the expected workspace (self_check.expected_workspace), whose files are the known-good workspace; put it beside task.yaml',
      },
    ]);
    expect(task.plan).toBeNull();
    // Without an expected workspace, a folder named expected/ is any other folder.
    const plain = withVerification(`  - { key: answer, type: numeric_tolerance, primary: true }
  - { key: judge, type: llm_judge, params: { rubric: expected/rubric.md } }
`);
    const fine = await analyse(base({ 'task.yaml': plain, 'expected/rubric.md': 'be fair' }));
    expect(fine.issues).toEqual([]);
    expect(fine.files.map((f) => [f.path, f.kind])).toContainEqual([
      'expected/rubric.md',
      'rubric',
    ]);
  });

  it('cannot self-check a file_check without an expected workspace', async () => {
    const yaml = withVerification(`  - { key: answer, type: numeric_tolerance, primary: true }
  - { key: out, type: file_check, params: { path: out.csv } }
`);
    const task = await analyse(base({ 'task.yaml': yaml }));
    expect(task.issues).toEqual([
      expect.objectContaining({
        code: 'self_check_unsupported',
        key: 'out',
        path: 'task.yaml#verification[1]',
      }),
    ]);
  });

  it('needs the expected workspace to be its own existing folder', async () => {
    const withExpected = (dir: string) =>
      `${TASK_YAML}self_check: { expected_workspace: ${dir} }\n`;
    const missing = await analyse(base({ 'task.yaml': withExpected('expected') }));
    expect(missing.issues).toEqual([
      expect.objectContaining({
        code: 'file_missing',
        path: 'task.yaml#self_check.expected_workspace',
      }),
    ]);
    const fixtures = await analyse(base({ 'task.yaml': withExpected('fixtures/') }));
    expect(fixtures.issues).toEqual([expect.objectContaining({ code: 'schema_invalid' })]);
    const dot = await analyse(base({ 'task.yaml': withExpected('.') }));
    expect(dot.issues).toEqual([expect.objectContaining({ code: 'schema_invalid' })]);
  });

  it('reports links and special files: errors where the task reads, warnings elsewhere', async () => {
    const task = await analyse(
      base({
        'fixtures/link.csv': { link: true },
        'fixtures/pipe': { fifo: true },
        'notes/link': { link: true },
        'fixtures/huge.csv': { bytes: MAX_SUITE_FILE_BYTES + 1 },
      }),
    );
    expect(task.issues.map((i) => [i.severity, i.code, i.path])).toEqual([
      ['error', 'unsafe_file', 'fixtures/huge.csv'],
      ['error', 'unsafe_file', 'fixtures/link.csv'],
      ['error', 'unsafe_file', 'fixtures/pipe'],
      ['warning', 'unsafe_file', 'notes/link'],
    ]);
    expect(task.files.map((f) => f.path)).toEqual(['fixtures/amounts.csv']);
    expect(task.plan).toBeNull();
  });

  it('refuses a task.yaml that is a link', async () => {
    const task = await analyse(base({ 'task.yaml': { link: true } }));
    expect(task.issues).toEqual([
      expect.objectContaining({ code: 'unsafe_file', path: 'task.yaml' }),
    ]);
  });
});

describe('prompt and reference', () => {
  it.each([
    ['not JSON', '{ total: 1 }', /^reference\.json is not valid JSON: /],
    ['out of range', '{ "total": 1e999 }', /out of range/],
  ])('refuses a reference that is %s', async (_what, reference, message) => {
    const task = await analyse(base({ 'reference.json': reference }));
    expect(task.issues).toEqual([
      expect.objectContaining({
        code: 'reference_invalid',
        message: expect.stringMatching(message),
      }),
    ]);
    expect(task.reference).toBeUndefined();
  });

  it('accepts any JSON value as the reference, including null', async () => {
    const task = await analyse(
      base({
        'reference.json': 'null',
        'task.yaml': withVerification('  - { key: answer, type: exact_match, primary: true }\n'),
      }),
    );
    expect(task.reference).toBeNull();
    expect(task.plan?.reference).toBeNull();
  });

  it('refuses an empty prompt and one with a NUL character', async () => {
    expect((await analyse(base({ 'prompt.md': '  \n' }))).issues).toEqual([
      expect.objectContaining({ code: 'schema_invalid', message: 'prompt.md is empty' }),
    ]);
    expect((await analyse(base({ 'prompt.md': 'a\0b ```json' }))).issues).toEqual([
      expect.objectContaining({
        code: 'schema_invalid',
        message: 'prompt.md contains a NUL character',
      }),
    ]);
  });
});
