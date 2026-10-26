/**
 * scripts/phase6-mock-scripts.json, the mock model's scripts for the
 * invoices-v1 experiment (baseline · with-skill, plan 18.3 and 18.5 step 3),
 * checked without a stack: each request an arm's run sends picks the script
 * meant for it (apps/egress/src/mock-model.ts plays the first script whose
 * `match` occurs anywhere in the request's messages), every reply makes real
 * Hermes tool calls before it answers, and the answers grade as the
 * experiment should come out: with the skill every task passes its primary
 * key; the baseline falls into the trap of eight tasks and gets the other
 * four right. The judge's answers for disputed are matched by the agent's
 * final text, which only the judge's request holds.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  listFiles,
  loadInvoicesSuite,
  MOCK_SCRIPTS,
  MockScriptsSchema,
  primaryKey,
  readText,
  REPO,
  SKILL_DIR,
  SKILL_PHRASE,
  scoreKey,
  SUITE_DIR,
  TASK_KEYS,
  type LoadedSuite,
  type MockScript,
  type RecordedRun,
  type TaskKey,
} from './support.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

/** The tasks whose baseline reply falls into the trap. */
const TRAPPED: readonly TaskKey[] = [
  'dup_invoices',
  'credit_notes',
  'currency_mix',
  'late_fees',
  'per_vendor',
  'disputed',
  'partial_pay',
  'summary_file',
];
const AGENT_TOOLS = ['read_file', 'terminal', 'write_file'];
const JudgeReplySchema = z.strictObject({ score: z.number().min(0).max(1), comment: z.string() });

let suite: LoadedSuite;
let scripts: MockScript[];
let prompts: Record<TaskKey, string>;
let skillMd: string;

beforeAll(async () => {
  scripts = MockScriptsSchema.parse(JSON.parse(await readText(REPO, MOCK_SCRIPTS)));
  prompts = Object.fromEntries(
    await Promise.all(TASK_KEYS.map(async (k) => [k, await readText(SUITE_DIR, k, 'prompt.md')])),
  ) as Record<TaskKey, string>;
  skillMd = await readText(SKILL_DIR, 'SKILL.md');
  suite = await loadInvoicesSuite();
});

afterAll(() => suite?.close());

/** Where invoices-v1's scripts start: other Phase 6 checks' scripts may come first. */
const start = () => scripts.findIndex((s) => s.match === SKILL_PHRASE) - 2;
const [judgeRight, judgeWrong, skill] = [0, 1, 2].map((i) => () => scripts[start() + i]!);
const baseline = (key: TaskKey) => scripts[start() + 3 + TASK_KEYS.indexOf(key)]!;
/** The mock's rule: the first script whose match occurs in the request's text. */
const chosen = (text: string) => scripts.find((s) => text.includes(s.match)) ?? null;
const finalText = (s: MockScript) => {
  const last = s.steps.at(-1)!;
  if (!('content' in last)) throw new Error(`${s.match}: the last step is not an answer`);
  return last.content;
};
const toolSteps = (s: MockScript) => s.steps.flatMap((step) => ('tool' in step ? [step] : []));

/** What a run with these steps leaves behind, as the evaluation reads it. */
const recorded = (s: MockScript): RecordedRun => ({
  text: finalText(s),
  calls: toolSteps(s).map((step) => ({ name: step.tool, input: step.arguments })),
  files: Object.fromEntries(
    toolSteps(s)
      .filter((step) => step.tool === 'write_file')
      .map((step) => [
        z
          .string()
          .parse(step.arguments.path)
          .replace(/^\/workspace\//, ''),
        z.string().parse(step.arguments.content),
      ]),
  ),
});

/** Every text file a run of the task can show the model: its prompt and its fixtures. */
async function taskTexts(key: TaskKey): Promise<string[]> {
  const fixtures = await listFiles(join(SUITE_DIR, key, 'fixtures'));
  return [
    prompts[key],
    ...(await Promise.all(fixtures.map((f) => readText(SUITE_DIR, key, 'fixtures', f)))),
  ];
}

describe('the scripts file', () => {
  it('holds the two judge replies, the with-skill script, then one baseline script per task', () => {
    expect(start()).toBeGreaterThanOrEqual(0);
    expect(scripts.slice(start())).toHaveLength(3 + TASK_KEYS.length);
    expect(skill().match).toBe(SKILL_PHRASE);
    for (const judge of [judgeRight(), judgeWrong()]) {
      expect(judge.steps).toHaveLength(1);
      JudgeReplySchema.parse(JSON.parse(finalText(judge)));
    }
    expect(
      JudgeReplySchema.parse(JSON.parse(finalText(judgeRight()))).score,
    ).toBeGreaterThanOrEqual(0.7);
    expect(JudgeReplySchema.parse(JSON.parse(finalText(judgeWrong()))).score).toBeLessThan(0.7);
  });

  it('makes real Hermes tool calls, in the workspace, before every answer', () => {
    for (const s of scripts.slice(start() + 2)) {
      const tools = toolSteps(s);
      expect(['read_file', 'terminal'], s.match).toContain(tools[0]?.tool);
      for (const step of tools) {
        expect(AGENT_TOOLS, s.match).toContain(step.tool);
        expect(JSON.stringify(step.arguments), s.match).toContain('/workspace/');
      }
      expect(finalText(s), s.match).toMatch(/```json\n.+\n```$/);
      expect(
        s.steps.slice(0, -1).every((step) => 'tool' in step),
        s.match,
      ).toBe(true);
    }
  });
});

describe('which script answers which request', () => {
  it('puts the skill phrase in SKILL.md and in no task, and each baseline phrase in its own prompt only', async () => {
    expect(skillMd).toContain(SKILL_PHRASE);
    const suiteFiles = await listFiles(SUITE_DIR);
    const texts = await Promise.all(suiteFiles.map((f) => readText(SUITE_DIR, f)));
    for (const [i, text] of texts.entries()) {
      expect(text.includes(SKILL_PHRASE), suiteFiles[i]).toBe(false);
      expect(
        text.includes(judgeRight().match) || text.includes(judgeWrong().match),
        suiteFiles[i],
      ).toBe(false);
    }
    for (const key of TASK_KEYS) {
      const owners = TASK_KEYS.filter((k) => prompts[k].includes(baseline(key).match));
      expect(owners, key).toEqual([key]);
    }
    for (const file of await listFiles(SKILL_DIR)) {
      const text = await readText(SKILL_DIR, file);
      for (const s of [judgeRight(), judgeWrong(), ...TASK_KEYS.map(baseline)]) {
        expect(text.includes(s.match), `${file}: ${s.match}`).toBe(false);
      }
    }
  });

  it.each(TASK_KEYS)('%s: every request of either arm picks that arm’s script', async (key) => {
    const seen = await taskTexts(key);
    // Each later request also carries the tool calls made so far.
    const asked = (s: MockScript) =>
      s.steps.map((_, n) => [
        ...seen,
        ...toolSteps(s)
          .slice(0, n)
          .map((t) => JSON.stringify(t.arguments)),
      ]);
    for (const texts of asked(baseline(key)))
      expect(chosen(texts.join('\n')), key).toBe(baseline(key));
    for (const texts of asked(skill())) {
      expect(chosen([skillMd, ...texts].join('\n')), key).toBe(skill());
    }
  });

  it("answers the judge's request for disputed by the arm's own final text", async () => {
    const rubric = await readText(SUITE_DIR, 'disputed/rubric.md');
    const reference = await readText(SUITE_DIR, 'disputed/reference.json');
    const request = (s: MockScript) =>
      [rubric, prompts.disputed, reference, finalText(s)].join('\n');
    expect(chosen(request(skill()))).toBe(judgeRight());
    expect(chosen(request(baseline('disputed')))).toBe(judgeWrong());
  });
});

describe('how the experiment grades', () => {
  it.each(TASK_KEYS)('%s: with the skill the primary key passes', async (key) => {
    const task = suite.byKey.get(key)!;
    const result = await scoreKey(task, primaryKey(task), recorded(skill()));
    expect(result.status, `${key}: ${result.comment}`).toBe('passed');
  });

  it.each(TASK_KEYS)('%s: the baseline passes or falls into the trap as planned', async (key) => {
    const task = suite.byKey.get(key)!;
    const result = await scoreKey(task, primaryKey(task), recorded(baseline(key)));
    expect(result.status, `${key}: ${result.comment}`).toBe(
      TRAPPED.includes(key) ? 'failed' : 'passed',
    );
  });

  it('passes the secondary checks with the skill, and fails the ones on the trapped baselines', async () => {
    const run = recorded(skill());
    const key = (task: TaskKey, name: string, r: RecordedRun) =>
      scoreKey(suite.byKey.get(task)!, name, r);
    for (const [task, name] of [
      ['vat_split', 'total_vat'],
      ['late_fees', 'fees'],
      ['per_vendor', 'reads_ledger'],
      ['summary_file', 'totals'],
    ] as const) {
      expect((await key(task, name, run)).status, `${task}.${name}`).toBe('passed');
    }
    expect((await key('late_fees', 'fees', recorded(baseline('late_fees')))).status).toBe('failed');
    expect((await key('per_vendor', 'reads_ledger', recorded(baseline('per_vendor')))).status).toBe(
      'failed',
    );
    expect((await key('summary_file', 'totals', recorded(baseline('summary_file')))).status).toBe(
      'failed',
    );
  });

  it('writes the expected summary.csv in the with-skill run', async () => {
    const expected = await readFile(join(SUITE_DIR, 'summary_file/expected/summary.csv'), 'utf8');
    expect(recorded(skill()).files).toEqual({ 'summary.csv': expected });
  });
});
