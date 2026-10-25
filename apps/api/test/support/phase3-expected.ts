/**
 * What the Phase 3 e2e expects of every score, task by task and
 * configuration by configuration: the status, score and comment each key
 * publishes (in the run inspector's view and in the stored row), and the
 * evidence of the types that have their own (trajectory_match, llm_judge,
 * text_match, verifier_script). The trials and the judge that produce them
 * are in phase3-trials.ts.
 */
import { expect } from 'vitest';
import type { JsonValue, ScoreEvidence, ScoreRowView, ScoreStatus } from '@hermes-evals/shared';
import {
  JUDGE_CALL_COST_USD,
  JUDGE_MODEL,
  JUDGE_TOKENS,
  TONE_VERDICT,
  VERDICTS,
  type Phase3Config,
  type Phase3Task,
} from './phase3-trials.js';

/** A stored score row, as much of it as the expectations read. */
export interface StoredScore {
  key: string;
  status: ScoreStatus;
  score: number | null;
  comment: string;
  isPrimary: boolean;
  evidence: ScoreEvidence;
  expected: JsonValue | null;
  observed: JsonValue | null;
}

/** The tool_use event sequence numbers of the attempt, by tool. */
export interface ToolSeqs {
  readFile: number[];
  terminal: number[];
}

interface Expectation {
  status: ScoreStatus;
  score: number | null;
  comment: string;
  /** Checks the stored evidence (and anything else of the row). */
  row?: (row: StoredScore) => void;
}

type Expected = Record<string, Expectation>;

const UNGRADABLE = 'no fenced JSON block found in final response';
const unanswered = (row: StoredScore): void =>
  expect(row).toMatchObject({ expected: null, observed: null, evidence: {} });

/**
 * An answer check's stored values: what the reference holds and what the
 * agent answered, and its evidence (json_match's counts; none for the others).
 */
const answered =
  (expected: JsonValue, observed: JsonValue, evidence: StoredScore['evidence'] = {}) =>
  (row: StoredScore): void => {
    expect(row).toMatchObject({ expected, observed });
    expect(row.evidence).toEqual(evidence);
  };

/**
 * evidence.judge of a judged key: the judge on Nous, one call, metered and
 * priced, with that call's status and latency in its call log.
 */
const judged = (verdict: { score: number; comment: string }, pass: boolean): Expectation => ({
  status: pass ? 'passed' : 'failed',
  score: verdict.score,
  comment: `Judge score ${verdict.score}, ${pass ? 'at or above' : 'below'} 0.7: ${verdict.comment}`,
  row: (row) => {
    expect(row.evidence.judge).toMatchObject({
      provider: 'nous',
      model: JUDGE_MODEL,
      calls: 1,
      tokens: {
        input: JUDGE_TOKENS.prompt,
        output: JUDGE_TOKENS.completion,
        total: JUDGE_TOKENS.prompt + JUDGE_TOKENS.completion,
      },
      cost_usd: JUDGE_CALL_COST_USD,
      finish_reason: 'stop',
      call_log: [{ status: 200, latency_ms: expect.any(Number) }],
    });
    expect(row.evidence.judge!.latency_ms).toBeGreaterThanOrEqual(0);
    expect(row.evidence.judge).not.toHaveProperty('base_url');
  },
});

function expectations(task: Phase3Task, config: Phase3Config, seqs: ToolSeqs): Expected {
  const right = config === 'right';
  switch (task) {
    case 'invoice_total':
      return {
        answer: right
          ? {
              status: 'passed',
              score: 1,
              comment: '|observed − expected| = 0.00000',
              row: answered(10.5, 10.5),
            }
          : {
              status: 'failed',
              score: 0,
              comment: '|observed − expected| = 0.500000',
              row: answered(10.5, 10),
            },
        reads_amounts: right
          ? {
              status: 'passed',
              score: 1,
              comment: '1 call to read_file with {"path":"amounts.csv"}; needs at least 1',
              row: (row) =>
                expect(row.evidence).toEqual({
                  event_seqs: seqs.readFile,
                  trajectory: { tool: 'read_file', calls: 1, matched_seqs: seqs.readFile },
                }),
            }
          : {
              status: 'failed',
              score: 0,
              comment: 'no call to read_file (tools called: terminal); needs at least 1',
              row: (row) =>
                expect(row.evidence).toEqual({
                  event_seqs: [],
                  trajectory: { tool: 'read_file', calls: 0, matched_seqs: [] },
                }),
            },
        reads_superset: {
          status: right ? 'passed' : 'failed',
          score: right ? 1 : 0,
          comment: right
            ? 'superset trajectory match passed: 1 tool call, 1 of them to read_file with {"path":"amounts.csv"}; needs at least 1 call to read_file with {"path":"amounts.csv"}'
            : 'superset trajectory match failed: 1 tool call, 0 of them to read_file with {"path":"amounts.csv"}; needs at least 1 call to read_file with {"path":"amounts.csv"}',
          row: (row) =>
            expect(row.evidence.trajectory).toEqual({
              tool: 'read_file',
              calls: 1,
              matched_seqs: right ? seqs.readFile : [],
              mode: 'superset',
            }),
        },
        method: right ? judged(VERDICTS.right, true) : judged(VERDICTS.wrong, false),
      };
    case 'ledger':
      return right
        ? {
            answer: {
              status: 'passed',
              score: 1,
              comment: '3 of 3 items match exactly (3 items)',
              row: answered(['a', 'b', 'c'], ['c', 'a', 'b'], {
                json_match: { unit: 'items', matched: 3, total: 3, mismatches: [] },
              }),
            },
            currency: { status: 'passed', score: 1, comment: 'equal', row: answered('EUR', 'eur') },
          }
        : {
            answer: { status: 'ungradable', score: null, comment: UNGRADABLE, row: unanswered },
            currency: { status: 'ungradable', score: null, comment: UNGRADABLE, row: unanswered },
          };
    case 'late_fee_rule':
      return {
        answer: {
          status: right ? 'passed' : 'failed',
          score: right ? 1 : 0.666667,
          comment: right
            ? 'found 3 of 3: "1.5%" ✓ "30 days" ✓ /after \\d+ days/ ✓'
            : 'found 2 of 3: "1.5%" ✓ "30 days" ✗ /after \\d+ days/ ✓',
          row: (row) => {
            expect(row.evidence.text).toEqual({
              items: [
                { kind: 'phrase', label: '1.5%', found: true },
                { kind: 'phrase', label: '30 days', found: right },
                { kind: 'pattern', label: 'after \\d+ days', found: true },
              ],
              truncated: false,
            });
            expect(row.expected).toEqual({
              contains: ['1.5%', '30 days'],
              pattern: 'after \\d+ days',
            });
          },
        },
        // No model in the check: JUDGE_MODEL grades it, on JUDGE_PROVIDER.
        tone: judged(TONE_VERDICT, true),
      };
    case 'summary_file':
      return {
        // The wrong summary has the right shape; only the verifier sees Globex's total is off.
        summary_csv: {
          status: 'passed',
          score: 1,
          comment: 'summary.csv: exists, valid CSV, has columns vendor, total, 2 data rows',
          row: (row) => {
            expect(row.observed).toMatchObject({ exists: true, row_count: 2 });
            // The collected summary.csv, which the inspector links to.
            expect(row.evidence.artifact_ids).toHaveLength(1);
          },
        },
        totals: {
          status: right ? 'passed' : 'failed',
          score: right ? 1 : 0.5,
          comment: right
            ? '2 of 2 vendors right (score 1, pass at 1)'
            : '1 of 2 vendors right (score 0.5, pass at 1)',
          row: (row) =>
            expect(row.evidence.script).toMatchObject({
              exit_code: 0,
              timed_out: false,
              // What check_summary.py printed, as Python's json.dumps writes it.
              stdout_line: right
                ? '{"score": 1.0, "comment": "2 of 2 vendors right"}'
                : '{"score": 0.5, "comment": "1 of 2 vendors right"}',
            }),
        },
      };
  }
}

/** Every key of one run, in the inspector's view and in the stored rows. */
export function expectScores(
  task: Phase3Task,
  config: Phase3Config,
  got: { view: readonly ScoreRowView[]; rows: Record<string, StoredScore>; seqs: ToolSeqs },
): void {
  const expected = expectations(task, config, got.seqs);
  const where = (key: string) => `${task}/${config} ${key}`;
  expect(got.view.map((s) => s.key).sort(), `${task}/${config}`).toEqual(
    Object.keys(expected).sort(),
  );
  expect(Object.keys(got.rows).sort()).toEqual(Object.keys(expected).sort());
  for (const [key, want] of Object.entries(expected)) {
    const view = got.view.find((s) => s.key === key)!;
    const row = got.rows[key]!;
    for (const shown of [view, row]) {
      expect(shown.status, where(key)).toBe(want.status);
      expect(shown.score, where(key)).toBe(want.score);
      expect(shown.comment, where(key)).toBe(want.comment);
    }
    expect(view.primary, where(key)).toBe(key === 'answer' || key === 'summary_csv');
    expect(view.primary).toBe(row.isPrimary);
    want.row?.(row);
  }
}
