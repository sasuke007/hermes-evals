/**
 * The Phase 3 check types end to end on PGlite: text_match, trajectory_match
 * and llm_judge keys graded by the evaluate-run handler over stored evidence,
 * each with seeded right and wrong attempts, and every status each type can
 * give (plan 17, Phase 3 exit). The judge is an in-process fake: no model is
 * ever called.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ScoreEvidenceSchema,
  type RunEventPayload,
  type VerificationEntry,
} from '@hermes-evals/shared';
import { createTestDatabase, type TestDatabase } from '../../test/support/database.js';
import { runEvents, scores } from '../database/schema/index.js';
import { hermesMcpToolName } from '../execution/stream-json.js';
import { JudgeError, NO_JUDGE_MODEL_MESSAGE } from '../scoring/judge/contracts.js';
import { SCORER_VERSIONS } from '../scoring/registry.js';
import { BlobStore } from '../storage/blob-store.js';
import { handleEvaluateRunJob, type EvaluationDeps } from './evaluate-run.handler.js';
import {
  executeRun,
  fenced,
  logger,
  recordingReconcile,
  seedScenario,
  type AttemptEvidence,
  type ScenarioTask,
} from './support-spec.js';
import { FakeJudge, judgeAnswer, MOCK_JUDGE_SETTINGS, verdictText } from './support-judge-spec.js';

let t: TestDatabase;
let dataDir: string;
let store: BlobStore;

beforeAll(async () => {
  t = await createTestDatabase();
  dataDir = await mkdtemp(join(tmpdir(), 'hermes-evals-phase3-'));
  store = new BlobStore(dataDir);
});

afterAll(async () => {
  await t?.close();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

/** Seeds the task, executes one run with `evidence`, grades it and returns its scores by key. */
async function grade(
  task: ScenarioTask,
  evidence: AttemptEvidence,
  deps: Partial<EvaluationDeps> = {},
) {
  const scenario = await seedScenario(t.db, store, task);
  const { evaluationId } = await executeRun(t.db, store, scenario, scenario.runIds[0]!, evidence);
  const result = await handleEvaluateRunJob(
    { evaluationId },
    { db: t.db, store, reconcile: recordingReconcile().reconcile, ...deps },
    logger(),
  );
  expect(result.outcome).toBe('published');
  const rows = await t.db
    .select()
    .from(scores)
    .where(eq(scores.evaluationId, evaluationId))
    .orderBy(asc(scores.key));
  for (const row of rows) {
    expect(row.scorerVersion).toBe(SCORER_VERSIONS[row.type]);
    expect(ScoreEvidenceSchema.safeParse(row.evidence).success).toBe(true);
  }
  return Object.fromEntries(rows.map((row) => [row.key, row]));
}

describe('text_match', () => {
  // DESIGN_CHECKS_FIX_PROMPT.md Part F's late_fee_rule.
  const RULE =
    'Invoices unpaid 30 days after the due date are charged a late fee of 1.5% per month.';
  const verification: VerificationEntry[] = [
    {
      key: 'answer',
      type: 'text_match',
      primary: true,
      params: { path: 'rule', contains: ['1.5%', '30 days'] },
    },
    {
      key: 'rate',
      type: 'text_match',
      primary: false,
      params: { path: 'rule', pattern: '\\d+(\\.\\d+)?% per month' },
    },
    { key: 'fee', type: 'text_match', primary: false, params: { path: 'fee', contains: ['late'] } },
    {
      key: 'slow',
      type: 'text_match',
      primary: false,
      params: { path: 'rule', pattern: '^(\\w+\\s?)+$' },
    },
  ];
  const task: ScenarioTask = { verification, reference: { rule: RULE } };

  it('passes a right answer and fails a wrong one with the share found', async () => {
    const right = await grade(task, { finalText: fenced({ rule: RULE.toUpperCase() }) });
    expect(right.answer).toMatchObject({ status: 'passed', score: 1, isPrimary: true });
    expect(right.answer!.comment).toBe('found 2 of 2: "1.5%" ✓ "30 days" ✓');
    expect(right.rate).toMatchObject({ status: 'passed', score: 1 });
    expect(right.answer!.evidence.text).toEqual({
      items: [
        { kind: 'phrase', label: '1.5%', found: true },
        { kind: 'phrase', label: '30 days', found: true },
      ],
      truncated: false,
    });

    const wrong = await grade(task, {
      finalText: fenced({ rule: 'A late fee of 1.5% applies.' }),
    });
    expect(wrong.answer).toMatchObject({ status: 'failed', score: 0.5 });
    expect(wrong.answer!.comment).toBe('found 1 of 2: "1.5%" ✓ "30 days" ✗');
    expect(wrong.rate).toMatchObject({ status: 'failed', score: 0 });
  });

  it('errors a check whose reference lacks its path, and a pattern that backtracks', async () => {
    const byKey = await grade(task, {
      finalText: fenced({ rule: `${'word '.repeat(30)}!` }),
    });
    expect(byKey.fee).toMatchObject({ status: 'error', score: null });
    expect(byKey.fee!.comment).toBe('the reference has no value at fee');
    expect(byKey.slow).toMatchObject({ status: 'error', score: null });
    expect(byKey.slow!.comment).toMatch(/^the pattern took longer than 1 s/);
  });

  it('is ungradable without an answer block', async () => {
    const byKey = await grade(task, { finalText: `The rule is: ${RULE}` });
    for (const key of ['answer', 'rate']) {
      expect(byKey[key]).toMatchObject({
        status: 'ungradable',
        score: null,
        comment: 'no fenced JSON block found in final response',
      });
    }
  });
});

describe('trajectory_match', () => {
  const GET_INVOICE = hermesMcpToolName('invoice-db', 'get_invoice');
  const verification: VerificationEntry[] = [
    {
      key: 'answer',
      type: 'exact_match',
      primary: true,
      params: { path: 'vendor' },
    },
    {
      key: 'reads_ledger',
      type: 'trajectory_match',
      primary: false,
      params: { tool: 'read_file', args: { path: 'invoices.csv' } },
    },
    {
      key: 'asks_db',
      type: 'trajectory_match',
      primary: false,
      params: { tool: GET_INVOICE, args: { invoice_no: 'INV-1001' }, max_calls: 1 },
    },
    {
      key: 'no_shell',
      type: 'trajectory_match',
      primary: false,
      params: { tool: 'terminal', min_calls: 0, max_calls: 0 },
    },
    {
      key: 'whole',
      type: 'trajectory_match',
      primary: false,
      params: { tool: 'read_file', args: { path: 'invoices.csv' }, mode: 'superset' },
    },
  ];
  const task: ScenarioTask = { verification, reference: { vendor: 'Acme Supplies' } };
  const use = (name: string, id: string, input: unknown): RunEventPayload =>
    ({ type: 'tool_use', name, tool_call_id: id, input, timestamp: 1 }) as RunEventPayload;
  const result = (name: string, id: string): RunEventPayload =>
    ({
      type: 'tool_result',
      name,
      tool_call_id: id,
      output: '{"ok": true}',
      duration_ms: 3,
      is_error: false,
    }) as RunEventPayload;
  const answer = fenced({ vendor: 'Acme Supplies' });

  it('passes an attempt that read the ledger and asked the database once', async () => {
    const byKey = await grade(task, {
      finalText: answer,
      events: [
        { type: 'system', subtype: 'init' } as RunEventPayload,
        use(GET_INVOICE, 'call_0', { invoice_no: 'INV-1001' }),
        result(GET_INVOICE, 'call_0'),
        use('read_file', 'call_1', { path: 'invoices.csv', offset: 0 }),
        result('read_file', 'call_1'),
        { type: 'result', text: answer } as RunEventPayload,
      ],
    });
    expect(byKey.reads_ledger).toMatchObject({ status: 'passed', score: 1 });
    expect(byKey.reads_ledger!.evidence).toEqual({
      event_seqs: [4],
      trajectory: { tool: 'read_file', calls: 1, matched_seqs: [4] },
    });
    expect(byKey.asks_db).toMatchObject({ status: 'passed', score: 1 });
    expect(byKey.no_shell).toMatchObject({ status: 'passed', score: 1 });
    expect(byKey.whole).toMatchObject({ status: 'passed', score: 1 });
    expect(byKey.whole!.evidence.trajectory).toMatchObject({ mode: 'superset', calls: 2 });
  });

  it('fails an attempt that used the shell, asked twice and never read the ledger', async () => {
    const byKey = await grade(task, {
      finalText: answer,
      events: [
        use(GET_INVOICE, 'call_0', { invoice_no: 'INV-1001' }),
        result(GET_INVOICE, 'call_0'),
        use(GET_INVOICE, 'call_1', { invoice_no: 'INV-1001' }),
        use('terminal', 'call_2', { command: 'cat invoices.csv' }),
        result('terminal', 'call_2'),
        use('read_file', 'call_3', { path: 'notes.md' }),
      ],
    });
    expect(byKey.reads_ledger).toMatchObject({ status: 'failed', score: 0 });
    expect(byKey.reads_ledger!.comment).toBe(
      '0 of 1 call to read_file match {"path":"invoices.csv"}; needs at least 1',
    );
    expect(byKey.asks_db).toMatchObject({ status: 'failed', score: 0 });
    expect(byKey.no_shell).toMatchObject({ status: 'failed', score: 0 });
    expect(byKey.whole).toMatchObject({ status: 'failed', score: 0 });
  });

  it('is never ungradable: without an answer block it still grades the calls', async () => {
    const byKey = await grade(task, {
      finalText: 'No answer.',
      events: [use('read_file', 'c', { path: 'invoices.csv' }), result('read_file', 'c')],
    });
    expect(byKey.answer!.status).toBe('ungradable');
    expect(byKey.reads_ledger).toMatchObject({ status: 'passed' });
  });

  it('errors on a stored tool event it cannot read', async () => {
    const byKey = await grade(task, {
      finalText: answer,
      // The database checks only that the payload's type matches the row's.
      events: [{ type: 'tool_use' } as RunEventPayload],
    });
    for (const key of ['reads_ledger', 'asks_db', 'no_shell', 'whole']) {
      expect(byKey[key]).toMatchObject({
        status: 'error',
        score: null,
        comment:
          "could not read the attempt's tool calls: event 1 is a tool_use without a tool name",
      });
    }
    expect(byKey.answer!.status).toBe('passed');
  });

  it('errors on every trajectory key, never a zero, when the events cannot be read', async () => {
    // The database, except that the events read (evidence.ts loadEvents) fails
    // the way a dropped connection or a statement timeout would.
    let reads = 0;
    const failing = new Proxy(t.db, {
      get(target, prop) {
        const value: unknown = Reflect.get(target, prop, target);
        if (prop !== 'select' || typeof value !== 'function') {
          return typeof value === 'function' ? value.bind(target) : value;
        }
        return (fields?: Record<string, unknown>) => {
          if (fields?.seq !== runEvents.seq) return value.call(target, fields);
          reads += 1;
          const refused = () => Promise.reject(new Error('canceling statement due to timeout'));
          return { from: () => ({ where: () => ({ orderBy: refused }) }) };
        };
      },
    });
    const byKey = await grade(
      task,
      {
        finalText: answer,
        events: [use('read_file', 'c', { path: 'invoices.csv' }), result('read_file', 'c')],
      },
      { db: failing },
    );
    for (const key of ['reads_ledger', 'asks_db', 'no_shell', 'whole']) {
      expect(byKey[key]).toMatchObject({
        status: 'error',
        score: null,
        comment: "could not read the attempt's events: canceling statement due to timeout",
      });
    }
    // Read once: the context keeps the failed read for the rest of the pass.
    expect(reads).toBe(1);
    expect(byKey.answer).toMatchObject({ status: 'passed', score: 1 });
  });
});

describe('llm_judge', () => {
  const RUBRIC = 'Score 1 when the reply names the total and how it was found.\n';
  const verification: VerificationEntry[] = [
    { key: 'answer', type: 'numeric_tolerance', primary: true, params: { path: 'total' } },
    { key: 'quality', type: 'llm_judge', primary: false, params: { rubric: 'rubric.md' } },
  ];
  const task: ScenarioTask = {
    verification,
    reference: { total: 1042 },
    files: [{ path: 'rubric.md', kind: 'rubric', content: RUBRIC }],
  };
  const RIGHT = fenced({ total: 1042 }, 'I summed the amount column of invoices.csv: 1042.');
  const WRONG = fenced({ total: 999 }, 'Roughly 999.');
  /** Grades by what the reply says: the fake stands in for a model following the rubric. */
  const fairJudge = () =>
    new FakeJudge((request) =>
      judgeAnswer(
        request.messages.user.includes('1042')
          ? verdictText(0.9, 'Names the total and the method.')
          : verdictText(0.2, 'The total is wrong.'),
      ),
    );

  it('passes a right reply and fails a wrong one, with the rubric and the reply in the request', async () => {
    const judge = fairJudge();
    const deps = { judge, judgeSettings: MOCK_JUDGE_SETTINGS };
    const right = await grade(task, { finalText: RIGHT }, deps);
    expect(right.quality).toMatchObject({ status: 'passed', score: 0.9 });
    expect(right.quality!.comment).toMatch(/Names the total and the method\.$/);
    expect(right.quality!.evidence.judge).toMatchObject({
      provider: 'custom',
      model: 'mock/judge',
      calls: 1,
      tokens: { input: 900, output: 30, total: 930 },
      // The seeded experiment's frozen price table has no price for the judge model.
      cost_usd: null,
    });
    expect(judge.requests).toHaveLength(1);
    const [request] = judge.requests;
    expect(request).toMatchObject({ provider: 'custom', model: 'mock/judge' });
    expect(request!.messages.system).toContain(RUBRIC.trim());
    expect(request!.messages.system).toContain('Reply with a fenced JSON block.');
    expect(request!.messages.user).toContain('I summed the amount column of invoices.csv');

    const wrong = await grade(task, { finalText: WRONG }, deps);
    expect(wrong.quality).toMatchObject({ status: 'failed', score: 0.2 });
    expect(wrong.answer).toMatchObject({ status: 'failed' });
  });

  it('errors when the judge answers outside the contract, and never scores it zero', async () => {
    const prose = new FakeJudge(() => judgeAnswer('I think this deserves a 7 out of 10.'));
    const byKey = await grade(
      task,
      { finalText: RIGHT },
      { judge: prose, judgeSettings: MOCK_JUDGE_SETTINGS },
    );
    expect(byKey.quality).toMatchObject({ status: 'error', score: null });
    expect(byKey.quality!.comment).toMatch(/^The judge's answer is not JSON/);
    expect(byKey.answer!.status).toBe('passed');

    const outOfRange = new FakeJudge(() => judgeAnswer(verdictText(7, 'Good.')));
    const ranged = await grade(
      task,
      { finalText: RIGHT },
      { judge: outOfRange, judgeSettings: MOCK_JUDGE_SETTINGS },
    );
    expect(ranged.quality).toMatchObject({ status: 'error', score: null });
  });

  it('errors without a judge model, a judge client or a ready provider', async () => {
    const unconfigured = await grade(task, { finalText: RIGHT }, { judge: fairJudge() });
    expect(unconfigured.quality).toMatchObject({
      status: 'error',
      score: null,
      comment: NO_JUDGE_MODEL_MESSAGE,
    });
    const noClient = await grade(
      task,
      { finalText: RIGHT },
      { judgeSettings: MOCK_JUDGE_SETTINGS },
    );
    expect(noClient.quality).toMatchObject({ status: 'error', score: null });
    const notReady = new FakeJudge(() => {
      throw new JudgeError('provider_not_ready', 'The judge provider custom is not ready.');
    });
    const refused = await grade(
      task,
      { finalText: RIGHT },
      { judge: notReady, judgeSettings: MOCK_JUDGE_SETTINGS },
    );
    expect(refused.quality).toMatchObject({
      status: 'error',
      score: null,
      comment: 'The judge provider custom is not ready.',
    });
  });

  it('errors when the task stores no rubric at the path the check names', async () => {
    const byKey = await grade(
      { ...task, files: [] },
      { finalText: RIGHT },
      { judge: fairJudge(), judgeSettings: MOCK_JUDGE_SETTINGS },
    );
    expect(byKey.quality).toMatchObject({
      status: 'error',
      score: null,
      comment: 'the task stores no rubric at rubric.md',
    });
  });

  it('is ungradable when the attempt left no final text', async () => {
    const judge = fairJudge();
    const byKey = await grade(
      task,
      { finalText: '' },
      { judge, judgeSettings: MOCK_JUDGE_SETTINGS },
    );
    expect(byKey.quality).toMatchObject({ status: 'ungradable', score: null });
    expect(judge.requests).toEqual([]);
  });
});
